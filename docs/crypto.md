# The Full Encryption & Steganography Pipeline

The process is divided into the Sender (Server) and the Receiver (Client), with a cryptographic handshake at the start.

## 1. The Handshake (Burn-Once-Dest-Check)

### Step 1: `/media/init`

- **Server**: Creates a random `sessionId` (UUID), generates 16-byte salt via `crypto.getRandomValues`, sets HttpOnly cookie `media-session-id`, derives key with `deriveKey(sessionId, salt)`, stores `{ key, isDirty }` in SECRETS.
- **Response**: Salt as binary body (`Content-Type: application/octet-stream`).
- **MediaPlayer**: Fetches via reqwest (WASM), receives salt; cookie is set by browser.

### Step 2: `/media/session`

- **Guards**: Cookie must be present; rejects if `isDirty === true`. After a valid response, sets `isDirty = true` (atomic burn-once).
- **Response**: Plain string `sessionId` on success, empty string `""` if invalid or already burned.
- **MediaPlayer**: Fetches via reqwest, parses body as text. If non-empty: derives key from `sessionId + salt`, stores only the key in WASM memory, discards `sessionId` and salt.

### Key Derivation

Both sides independently run Argon2id on `session_id` + `salt`. This creates a matching 32-byte Secret Key on both ends without the key ever traveling across the network. MediaPlayer holds only the derived key; sessionId and salt are discarded after handshake.

### Argon2id Parameters

| Parameter        | Value        | Notes                                 |
|------------------|--------------|---------------------------------------|
| Algorithm        | Argon2id     | Hybrid (side-channel + GPU resistant) |
| Memory (M)       | 4096 (4 MiB) | Kept low for WASM compatibility       |
| Iterations (T)   | 3            | Reasonable security/speed balance     |
| Parallelism (P)  | 1            | Single-threaded (WASM workers)        |
| Output length    | 32 bytes     | Matches ChaCha20-Poly1305 key size    |

Constants are defined in `media-core/src/secret.rs` and shared between server and client.

## 2. The Encoding (Server Side)

Compression: The raw video chunk (CMAF/fMP4) is compressed using zstd (level 3) to minimize the "hidden" footprint.

Encryption: The compressed data is encrypted using ChaCha20-Poly1305 with the derived Secret Key and a random 12-byte Nonce (generated via `OsRng`).

Encapsulation: The Nonce + Ciphertext are bundled into a binary payload.

The "Trick": This payload is appended to the end of a valid WebP image (a placeholder). The server serves this modified .webp file.

### Sealed Payload Format

```
┌──────────────────────┬───────────┬──────────────────────────────┐
│ Base WebP image      │ Nonce     │ Ciphertext + Auth Tag        │
│ (variable, RIFF)     │ (12 bytes)│ (variable, ChaCha20-Poly1305)│
└──────────────────────┴───────────┴──────────────────────────────┘
```

The RIFF header's size field marks where the legitimate WebP ends. Everything after `RIFF_offset + 8` is the hidden payload.

### Execution Context

Encryption runs on the **server** via **NAPI** (`media-secret` crate). The server uses `sealChunksStreaming` to seal each chunk and push it through a callback into Bun's direct `ReadableStream`, avoiding holding the full sealed response in memory.

Endpoint: `GET /_assets/:asset/:file` → serves sealed WebP with `Content-Type: image/webp`.

**Filename mangling**: The client requests image-like names; the server demangles to real media files:
- `image-0.webp` → `init-0.mp4`, `image-0-00001.webp` → `chunk-0-00001.m4s`

### Server Streaming: Binary Response

Elysia JSON-serializes handlers that return a raw `ReadableStream`, which corrupts binary payloads. To preserve binary, wrap the stream in a `Response`:

```ts
const stream = new ReadableStream({ type: "direct", pull(controller) { /* ... */ } });
return new Response(stream, {
  headers: { "Content-Type": "image/webp", "Cache-Control": "..." },
});
```

Tests in `services/server/src/crypto.test.ts` verify round-trip and streaming behavior.

## 3. The Decoding (Client Side)

Fetch: The Vue composable fetches sealed WebP from `/_assets/:asset/:file` with `credentials: "include"` (cookie sent).

Decryption: **MediaPlayer** (`media-client` WASM) holds the derived key. Encrypted buffers are passed directly to `initVideo`, `feedVideoSegment`, `initAudio`, and `feedAudioSegment`. Decryption happens internally in these methods via `media-core::secret::open_sealed_data` (parse RIFF → extract nonce + ciphertext → decrypt → decompress with ruzstd). Decrypted bytes never leave WASM memory.

Feed: Raw fMP4 bytes flow from the decryption step to the worker (video) or main-thread decoder (audio). The worker receives only raw segments — no decryption, no key.

### Execution Context

Decryption runs in **MediaPlayer** (`media-client` WASM) on the main thread. The key is derived via `handshake(baseUrl)` and never leaves WASM memory. The worker (`media-worker`) does not receive the key; it only decodes raw fMP4 with WebCodecs.

## 4. The Rendering (GPU Layer)

Isolation: The decrypted video bytes are fed into WebCodecs for decoding.

WebGPU Upload: The resulting video frame is uploaded directly to a GPU Texture.

Offscreen Rendering: The GPU renders the frame to an OffscreenCanvas.

Visual Output: Only the final, flattened pixels are shown on the user's screen, making it nearly impossible for a developer to "scrape" the source video from the browser's memory.

## Architecture

```
                 ┌──────────────────────────────┐
                 │         media-core           │
                 │ ──────────────────────────── │
                 │ - secret.rs                  │
                 │   • seal_data (seal feat.)   │
                 │   • open_sealed_data         │
                 │   • derive_key (Argon2id)    │
                 │ - fmp4.rs, seek_index.rs     │
                 └───────┬────────────┬─────────┘
                         │            │
         ┌───────────────▼──┐   ┌─────▼───────────────────┐
         │   media-secret   │   │   media-client (WASM)  │
         │    (NAPI)        │   │  • handshake, derive   │
         │   • seal feat.   │   │  • internal decrypt   │
         │   • cdylib       │   │  • holds key only      │
         └────────────┬─────┘   └─────────────┬─────────┘
                      │                       │ raw fMP4
           ┌──────────▼──────┐        ┌───────▼──────────┐
           │  Elysia Server  │        │  media-worker    │
           │ /media/init, /media/session│       │  (WASM)          │
           │ /_assets/:asset/:file    │  • raw decode only│
           └─────────────────┘       └───────────────────┘
```

## Endpoints

| Endpoint                      | Purpose                                      | Content-Type                              |
|-------------------------------|----------------------------------------------|-------------------------------------------|
| `/media/init`                 | Handshake: create session, set cookie, return salt binary | `application/octet-stream` |
| `/media/session`              | Handshake: return sessionId once (cookie + burn) | `text/plain`                |
| `/media/:asset/metadata.json` | Metadata                                     | `application/json`                        |
| `/media/:asset/:file`         | Raw CMAF chunks (non-encrypted, for testing) | `video/iso.segment` \| `video/mp4`         |
| `/_assets/:asset/:file`       | Sealed WebP chunks (encrypted, requires cookie) | `image/webp`                            |

## Summary of Protection Layers

| Layer             | Technology                  | Purpose                                            |
|-------------------|-----------------------------|----------------------------------------------------|
| Steganography     | WebP Append                 | Hides the existence of the video traffic.          |
| KDF               | Argon2id                    | Derives keys locally; no keys sent over the wire.  |
| Encryption        | ChaCha20-Poly1305           | Ensures confidentiality and integrity.             |
| Compression       | zstd (C) / ruzstd (WASM)    | Minimizes payload size; WASM uses pure-Rust impl.  |
| Thread Isolation  | Web Workers                 | Moves decryption away from the main JS console.    |
| Memory Isolation  | WebAssembly / WebGPU        | Keeps raw data in private binary/VRAM space.       |

## Reference

A repo of using rust to keep the secret in the image
https://github.com/catalin-i/pngme/
