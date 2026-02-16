# Build media-client WASM (main thread); set npm name to @media-stream/client
build-client:
    cd packages/media-client && wasm-pack build --target web --release --out-dir pkg
    bun run scripts/patch-wasm-pkg-name.ts packages/media-client/pkg/package.json @media-stream/client

# Build media-worker WASM (worker thread); set npm name to @media-stream/worker
build-worker:
    cd packages/media-worker && wasm-pack build --target web --release --out-dir pkg
    bun run scripts/patch-wasm-pkg-name.ts packages/media-worker/pkg/package.json @media-stream/worker

# Check media-worker (must use wasm target for web_sys WebCodecs/WebGPU APIs)
check-worker:
    cargo check -p media-worker --target wasm32-unknown-unknown
    cargo clippy -p media-worker --target wasm32-unknown-unknown --fix --allow-dirty

install-deps:
    bun install

# Build both WASM crates
build-wasm: build-client build-worker install-deps

# Test media-core (no WASM)
test-core:
    cargo test -p media-core

format:
    cargo fmt
    bun biome check --write ./services