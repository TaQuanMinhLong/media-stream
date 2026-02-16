# The Full Encryption & Steganography Pipeline

The process is divided into the Sender (Server) and the Receiver (Client), with a cryptographic handshake at the start.

## 1. The Handshake (Key Generation)

Client Action: Generates a random session\_id (UUID) and sends it to the server.

Server Action: Generates a unique Salt and links it to that session\_id in its database. It sends the Salt back to the client via an HTTP-only cookie.

Key Derivation: Both sides independently run Argon2 on the session\_id + Salt. This creates a matching 32-byte Secret Key on both ends without the key ever traveling across the network.

## 2. The Encoding (Server Side)

Compression: The raw video chunk (CMAF/fMP4) is compressed using zstd to minimize the "hidden" footprint.

Encryption: The compressed data is encrypted using ChaCha20-Poly1305 with the derived Secret Key and a random 12-byte Nonce.

Encapsulation: The Nonce + Ciphertext are bundled into a binary payload.

The "Trick": This payload is appended to the end of a valid WebP image (e.g., a 32x32 Google icon). The server serves this modified .webp file.

## 3. The Decoding (Client Side)

Fetch: The Vue.js app fetches the .webp "icon."

Extraction: Inside a Web Worker, the code parses the WebP RIFF header to find the "End of File" offset and grabs everything after it.

Decryption: The WASM "Black Box" uses the local Secret Key to decrypt the payload. If the key or data is tampered with, the Auth Tag fails, and the data is discarded.

Decompression: The chunk is decompressed back into its raw video format.

## 4. The Rendering (GPU Layer)

Isolation: The decrypted video bytes are fed into WebCodecs for decoding.

WebGPU Upload: The resulting video frame is uploaded directly to a GPU Texture.

Offscreen Rendering: The GPU renders the frame to an OffscreenCanvas.

Visual Output: Only the final, flattened pixels are shown on the user's screen, making it nearly impossible for a developer to "scrape" the source video from the browser's memory.

## Summary of Protection Layers

| Layer             | Technology               | Purpose                                                  |
|-------------------|-------------------------|----------------------------------------------------------|
| Steganography     | WebP Append             | Hides the existence of the video traffic.                |
| KDF               | Argon2id                | Derives keys locally; no keys sent over the wire.        |
| Encryption        | ChaCha20-Poly1305       | Ensures confidentiality and integrity.                   |
| Thread Isolation  | Web Workers             | Moves decryption away from the main JS console.          |
| Memory Isolation  | WebAssembly / WebGPU    | Keeps raw data in private binary/VRAM space.             |

## Reference

A repo of using rust to keep the secret in the image
https://github.com/catalin-i/pngme/
