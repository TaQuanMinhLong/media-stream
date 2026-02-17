# Architecture Overview

High-performance media playback using Rust (WASM) for low-level processing, WebCodecs for decode, and WebGPU for rendering.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        services/client (Vue + TypeScript)                   │
│  composables/media-player.ts  │  media-worker.ts (bootstrap)                │
│  • Fetch metadata & segments  │  • Load WASM, create GPU, delegate to Rust  │
│  • UI state, tick loop        │  • seek-index for segment URLs              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
┌──────────────┐          ┌────────────────┐          ┌──────────────┐
│ media-client │          │  media-worker  │          │  media-core  │
│   (WASM)     │  raw     │   (WASM)       │          │   (shared)   │
│              │ fMP4 ───►│                │          │              │
│ • handshake  │          │ • VideoDecoder │          │ • seek_index │
│ • decrypt    │          │ • frame queue  │          │ • fmp4 parse │
│ • init/feed  │          │ • WebGPU render│          │ • secret     │
│   video      │          │ • STATE_UPDATE │          │   (derive,   │
│ • init/feed  │          └────────────────┘          │    open)     │
│   audio      │                                      └──────────────┘
│ • audio on   │
│   main thread│
└──────────────┘
```

## Thread Model

* **Main thread**: `MediaPlayer` (media-client), audio decode/scheduling, composable UI
* **Worker thread**: `MediaWorker` (media-worker), video decode, WebGPU render

The worker receives only raw fMP4 bytes. Decryption runs in media-client before transfer. The secret key never leaves WASM memory.

## Package Roles

| Package         | Build                                | Role                                                                           |
|-----------------|--------------------------------------|--------------------------------------------------------------------------------|
| `media-core`    | `cargo build`                        | Pure Rust: `seek_index`, fMP4 parsing, Argon2id KDF, ChaCha20-Poly1305 decrypt |
| `media-client`  | `wasm-pack` → `@media-stream/client` | Main thread: handshake, decrypt, audio pipeline, worker lifecycle              |
| `media-worker`  | `wasm-pack` → `@media-stream/worker` | Worker thread: video decode, WebGPU render, state updates                      |
| `media-secret`  | `napi build` → `@media-stream/secret`| Server NAPI: seal chunks for streaming (Node/Bun)                              |

## Live vs Reference

The live client uses Rust WASM for heavy lifting. A TypeScript snapshot in `services/client/src/_reference/` documents the original pre-migration implementation. See that README for the mapping from old TS modules to Rust crates.
