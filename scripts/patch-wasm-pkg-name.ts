/**
 * Patch the "name" field in a wasm-pack generated package.json (e.g. to use @media-stream/client).
 * Usage: bun run scripts/patch-wasm-pkg-name.ts <path-to-pkg/package.json> <new-name>
 * Example: bun run scripts/patch-wasm-pkg-name.ts packages/media-client/pkg/package.json @media-stream/client
 */

const [pkgPath, name] = process.argv.slice(2);
if (!pkgPath || !name) {
  console.error(
    "Usage: bun run scripts/patch-wasm-pkg-name.ts <path-to-pkg/package.json> <new-name>",
  );
  process.exit(1);
}

const fs = await import("node:fs");
const path = await import("node:path");
const resolved = path.resolve(process.cwd(), pkgPath);

const pkg = JSON.parse(fs.readFileSync(resolved, "utf-8"));
pkg.name = name;
fs.writeFileSync(resolved, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${resolved}: name set to "${name}"`);
