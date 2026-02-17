import { existsSync } from "node:fs";
import path from "node:path";
import { deriveKey, sealData } from "@media-stream/secret";
import { Elysia } from "elysia";

/**
 * sessionId -> { key: Buffer, isDirty: boolean }
 *
 * TODO: replace with a real persistent storage like Redis
 */
const SECRETS = new Map<string, { key: Uint8Array; isDirty: boolean }>();
const MEDIA_ROOT = process.env.MEDIA_DIR || path.join(process.cwd(), "media");
const COOKIE_NAME = "media-session-id";

if (!existsSync(MEDIA_ROOT)) {
  console.error("❌ MEDIA_ROOT not found:", MEDIA_ROOT);
  process.exit(1);
}

function safeResolve(...segments: string[]) {
  const resolved = path.resolve(MEDIA_ROOT, ...segments);
  if (!resolved.startsWith(MEDIA_ROOT)) throw new Error("Path traversal detected");
  return resolved;
}

/** Demangle image-like filename to real media file: image-0.webp -> init-0.mp4, image-0-00001.webp -> chunk-0-00001.m4s */
function demangleAssetFilename(mangled: string): string {
  const initMatch = mangled.match(/^image-(\d+)\.webp$/i);
  if (initMatch) return `init-${initMatch[1]}.mp4`;
  const chunkMatch = mangled.match(/^image-(\d+)-(\d+)\.webp$/i);
  if (chunkMatch) return `chunk-${chunkMatch[1]}-${chunkMatch[2]}.m4s`;
  return mangled;
}

new Elysia()
  .get("/", () => ({ status: "Media Server is online" }))
  .get("/media/session", async ({ cookie, set }) => {
    const sessionId = cookie[COOKIE_NAME]?.value as string | undefined;
    if (!sessionId || !SECRETS.has(sessionId)) {
      set.headers["Content-Type"] = "text/plain";
      return "";
    }
    const secret = SECRETS.get(sessionId)!;
    if (secret.isDirty) {
      set.headers["Content-Type"] = "text/plain";
      return "";
    }
    secret.isDirty = true;
    set.headers["Content-Type"] = "text/plain";
    return sessionId;
  })
  .get("/media/init", async ({ cookie, set }) => {
    const sessionId = crypto.randomUUID();
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    cookie[COOKIE_NAME]!.value = sessionId;
    cookie[COOKIE_NAME]!.httpOnly = true;
    cookie[COOKIE_NAME]!.sameSite = "strict";
    cookie[COOKIE_NAME]!.secure = process.env.NODE_ENV === "production";
    const key = deriveKey(sessionId, salt);
    SECRETS.set(sessionId, { key, isDirty: false });
    set.headers["Content-Type"] = "application/octet-stream";
    return salt.buffer;
  })
  // MATCHES: /media/sample/metadata.json
  .get("/media/:asset/metadata.json", async ({ params, set }) => {
    const { asset } = params;
    const filePath = safeResolve(asset, "metadata.json");
    const fileRef = Bun.file(filePath);
    if (!(await fileRef.exists())) {
      set.status = 404;
      return "Metadata not found";
    }
    set.headers["Content-Type"] = "application/json";
    set.headers["Cache-Control"] = "public, max-age=60";
    return fileRef;
  })
  // Encrypted endpoint: serves sealed WebP wrapping the same chunk data.
  // Client decrypts internally in WASM (media-client) via media_core::secret::open_sealed_data.
  .get("/_assets/:asset/:file", async ({ params, set, cookie }) => {
    const sessionId = cookie[COOKIE_NAME]?.value as string | undefined;
    const secretKey = sessionId ? SECRETS.get(sessionId) : undefined;
    if (!sessionId || !secretKey?.key) {
      set.status = 401;
      return "Unauthorized";
    }

    const { asset, file } = params;
    const realFile = demangleAssetFilename(file);
    const filePath = safeResolve(asset, realFile);
    const fileRef = Bun.file(filePath);

    if (!(await fileRef.exists())) {
      set.status = 404;
      return "File not found";
    }

    const rawBytes = await fileRef.arrayBuffer();
    const sealed = sealData(rawBytes, secretKey.key);

    return new Response(sealed, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  .listen(3000);

console.log(`🦊 Media server running at http://localhost:3000`);
