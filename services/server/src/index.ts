import { existsSync } from "node:fs";
import path from "node:path";
import { deriveKey, sealChunksStreaming } from "@media-stream/secret";
import { Elysia } from "elysia";

/**
 * sessionId -> { key: Buffer, isDirty: boolean }
 *
 * TODO: replace with a real persistent storage like Redis
 */
const SECRETS = new Map<string, { key: Buffer; isDirty: boolean }>();
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

new Elysia()
  .get("/", () => ({ status: "Media Server Ready" }))
  .get("/_session", async ({ cookie, set }) => {
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
  .get("/_init", async ({ cookie, set }) => {
    const sessionId = crypto.randomUUID();
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const saltBuffer = Buffer.from(salt);
    cookie[COOKIE_NAME]!.value = sessionId;
    cookie[COOKIE_NAME]!.httpOnly = true;
    cookie[COOKIE_NAME]!.sameSite = "strict";
    cookie[COOKIE_NAME]!.secure = process.env.NODE_ENV === "production";
    const key = deriveKey(sessionId, saltBuffer);
    SECRETS.set(sessionId, { key, isDirty: false });
    set.headers["Content-Type"] = "application/octet-stream";
    return saltBuffer;
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

  // MATCHES: /media/sample/chunk-0-00001.m4s
  // TODO: remove this later when encrypted endpoint is ready
  .get("/media/:asset/:file", async ({ params, set }) => {
    const { asset, file } = params;

    // Safety: ensure file exists before attempting to serve
    const filePath = safeResolve(asset, file);
    const fileRef = Bun.file(filePath);

    if (!(await fileRef.exists())) {
      set.status = 404;
      console.error(`File not found: ${filePath}`);
      return "File not found";
    }

    // Set correct headers for media streaming
    set.headers["Content-Type"] = file.endsWith(".m4s") ? "video/iso.segment" : "video/mp4";
    set.headers["Cache-Control"] = "public, max-age=31536000, immutable";

    return fileRef;
  })

  // Encrypted endpoint: serves sealed WebP wrapping the same chunk data.
  // Client worker decrypts internally via media_core::secret::open_sealed_data.
  .get("/_assets/:asset/:file", async ({ params, set, cookie }) => {
    const sessionId = cookie[COOKIE_NAME]?.value as string | undefined;
    const secretKey = sessionId ? SECRETS.get(sessionId) : undefined;
    if (!sessionId || !secretKey?.key) {
      set.status = 401;
      return "Unauthorized";
    }

    const { asset, file } = params;
    const filePath = safeResolve(asset, file);
    const fileRef = Bun.file(filePath);

    if (!(await fileRef.exists())) {
      set.status = 404;
      return "File not found";
    }

    const rawBytes = await fileRef.arrayBuffer();

    const stream = new ReadableStream({
      type: "direct",
      pull(controller) {
        sealChunksStreaming([Buffer.from(rawBytes)], secretKey.key, (chunk: Buffer) => {
          controller.write(chunk);
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  .listen(3000);

console.log(`🦊 Media server running at http://localhost:3000`);
