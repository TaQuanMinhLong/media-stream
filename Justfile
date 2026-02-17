# Build media-client WASM (main thread); set npm name to @media-stream/client
build-client:
    cd packages/media-client && wasm-pack build --target web --release --out-dir pkg
    bun run scripts/patch-wasm-pkg-name.ts packages/media-client/pkg/package.json @media-stream/client

# Build media-worker WASM (worker thread); set npm name to @media-stream/worker
build-worker:
    cd packages/media-worker && wasm-pack build --target web --release --out-dir pkg
    bun run scripts/patch-wasm-pkg-name.ts packages/media-worker/pkg/package.json @media-stream/worker

# Build media-secret NAPI addon (server-side encryption)
build-secret:
    cd packages/media-secret && \
    napi build --release --platform --package-json-path=./pkg/package.json -o=./pkg

# Check media-worker (must use wasm target for web_sys WebCodecs/WebGPU APIs)
check:
    cargo clippy -p media-client --target wasm32-unknown-unknown --fix --allow-dirty
    cargo clippy -p media-worker --target wasm32-unknown-unknown --fix --allow-dirty

install-deps:
    bun install

# Build both WASM crates
build-wasm: build-client build-worker install-deps

# Build both WASM crates and NAPI addon
build: build-secret build-wasm

# Test media-core (with seal feature for crypto round-trip)
test-core:
    cargo test -p media-core --features seal

test-client:
    cd services/client && bun test

test-server:
    cd services/server && bun test

test: test-core test-client test-server

format:
    cargo fmt
    bun biome check --write ./services