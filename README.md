## media-stream

A monorepo for experimenting with high-performance media playback in the browser.\
It combines Rust (compiled to WebAssembly) for low-level media processing with a Bun-powered TypeScript/Vue client.

Documentation: `docs/crypto.md` — handshake flow, sealed WebP format, and server streaming notes.

### Project structure

* **Root workspace**
  * Managed with **Bun** workspaces (see `package.json`)
  * Shared tooling (Biome, scripts)
* **services/**
  * `services/client`: Web client (Vue + TypeScript, powered by Bun)
  * `services/server`: Backend / API (Bun)
* **packages/**
  * `packages/media-core`: Core Rust crate with media primitives and crypto (seal/open, derive_key)
  * `packages/media-client`: Rust crate compiled to WASM for main-thread usage (`@media-stream/client`)
  * `packages/media-worker`: Rust crate compiled to WASM for worker-thread usage (`@media-stream/worker`)
  * `packages/media-secret`: NAPI addon for server-side encryption (`@media-stream/secret`)

### Prerequisites

* **Bun** (for JS/TS tooling and the dev server)\
  Install from the official docs (`https://bun.sh`).
* **Rust toolchain** with `wasm32-unknown-unknown` target
  * Install Rust via `rustup`, then:

```bash
rustup target add wasm32-unknown-unknown
```

* **wasm-pack** (for building the WASM crates)

```bash
cargo install wasm-pack
```

### Installing dependencies

From the repo root:

```bash
just install-deps
```

This runs `bun install` using the root workspace configuration.

### Justfile recipes

This project uses a `Justfile` at the root as the main entrypoint for common tasks:

* **Build client WASM package**

  ```bash
  just build-client
  ```

  Builds `packages/media-client` with `wasm-pack` for the web target and patches its npm name to `@media-stream/client`.

* **Build worker WASM package**

  ```bash
  just build-worker
  ```

  Builds `packages/media-worker` with `wasm-pack` for the web target and patches its npm name to `@media-stream/worker`.

* **Build all WASM artifacts + install deps**

  ```bash
  just build-wasm
  ```

  Runs `build-client`, `build-worker`, and `install-deps`.

* **Check WASM crates with clippy (wasm32 target)**

  ```bash
  just check
  ```

* **Run core Rust tests** (includes seal/open round-trip)

  ```bash
  just test-core
  ```

* **Run server crypto tests** (sealData/openSealedData, streaming)

  ```bash
  bun run --cwd services/server test
  ```

* **Format code (Rust + client)**

  ```bash
  just format
  ```

  Runs `cargo fmt` and `bun biome check --write ./services`.

### Bun scripts

The root `package.json` exposes a few helpful Bun scripts:

* **Start client dev server**

  ```bash
  bun run dev:client
  ```

* **Start server dev process**

  ```bash
  bun run dev:server
  ```

* **Run client tests**

  ```bash
  bun run test:client
  ```

All of these commands must be run from the repo root.

### Typical workflow

1. **Install dependencies**

   ```bash
   just install-deps
   ```

2. **Build WASM crates**

   ```bash
   just build-wasm
   ```

3. **Run the client**

   ```bash
   bun run dev:client
   ```

4. (Optional) **Run tests / checks**

   ```bash
   just test-core
   bun run --cwd services/server test
   just check
   ```

5. **Encrypted pipeline**: The client always uses `/_assets` with the Burn-Once handshake; buffers are decrypted internally in WASM. See `docs/crypto.md` for the full pipeline.
