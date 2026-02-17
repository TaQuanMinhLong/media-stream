# media-stream Client

Vue 3 + TypeScript frontend for high-performance encrypted media playback. Uses Rust WASM (`@media-stream/client`, `@media-stream/worker`) for decode, decrypt, and WebGPU render.

## Setup

From the repo root:

```bash
just install-deps
just build-wasm
bun run dev:client
```

## Structure

- **composables/media-player.ts** — `useMediaPlayer`: fetches metadata/segments, wires `MediaPlayer` (WASM), tick loop
- **media-worker.ts** — Worker entry: loads WASM, creates WebGPU context, delegates to `MediaWorker` (Rust)
- **utils/seek-index.ts** — `timeToSegmentIndex`, `formatSegmentUrl` for CMAF segment URLs
- **shaders/video.wgsl** — WebGPU shader for video texture render

The heavy logic (handshake, decrypt, fMP4 parse, video decode, audio decode) lives in the Rust crates. See `src/_reference/README.md` for the migration reference.
