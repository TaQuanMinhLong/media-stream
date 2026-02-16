import { existsSync } from "node:fs";
import path from "node:path";
import { Elysia } from "elysia";

const MEDIA_ROOT = process.env.MEDIA_DIR || path.join(process.cwd(), "media");

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
  .listen(3000);

console.log(`🦊 Media server running at http://localhost:3000`);
