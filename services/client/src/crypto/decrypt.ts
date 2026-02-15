/**
 * Decrypt layer: mock passthrough. Interface is designed for future WASM replacement.
 * Encrypt/decrypt will happen inside the WASM module; this module is the TS boundary.
 *
 * @param data - Raw bytes (e.g. segment from network).
 * @returns Decrypted bytes. Mock implementation returns input unchanged.
 */
export async function decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
  return data;
}
