use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Seal raw data into a steganographic WebP blob.
///
/// Calls `media_core::secret::seal_data` (compress → encrypt → embed in WebP).
#[napi(js_name = "sealData")]
pub fn seal_data_napi(data: Buffer, secret_key: Buffer) -> Result<Buffer> {
    let key: [u8; 32] = secret_key
        .as_ref()
        .try_into()
        .map_err(|_| Error::from_reason("secret_key must be exactly 32 bytes"))?;

    let sealed = media_core::secret::seal_data(data.as_ref(), &key)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(sealed.into())
}

/// Derive a 32-byte key from session_id + salt using Argon2id.
#[napi(js_name = "deriveKey")]
pub fn derive_key_napi(session_id: String, salt: Buffer) -> Result<Buffer> {
    let key = media_core::secret::derive_key(session_id.as_bytes(), salt.as_ref())
        .map_err(|e| Error::from_reason(format!("key derivation failed: {e}")))?;
    Ok(Buffer::from(key.to_vec()))
}

// /// Open a sealed WebP blob (decrypt + decompress). For testing and verification.
// #[napi(js_name = "openSealedData")]
// pub fn open_sealed_data_napi(data: Buffer, secret_key: Buffer) -> Result<Buffer> {
//     let key: [u8; 32] = secret_key
//         .as_ref()
//         .try_into()
//         .map_err(|_| Error::from_reason("secret_key must be exactly 32 bytes"))?;

//     let opened = media_core::secret::open_sealed_data(data.as_ref(), &key)
//         .ok_or_else(|| Error::from_reason("open_sealed_data failed (wrong key or corrupted)"))?;

//     Ok(Buffer::from(opened))
// }

/// Seal each chunk and push the sealed blob to JS via the `on_chunk` callback.
///
/// The JS side creates a `ReadableStream` (Bun direct stream) and calls
/// `controller.write(chunk)` inside the callback. This keeps streaming entirely
/// in JS while Rust drives the seal-per-chunk loop.
#[napi(js_name = "sealChunksStreaming")]
pub fn seal_chunks_streaming_napi(
    chunks: Vec<Buffer>,
    secret_key: Buffer,
    on_chunk: Function<'_, Buffer, ()>,
) -> Result<()> {
    let key: [u8; 32] = secret_key
        .as_ref()
        .try_into()
        .map_err(|_| Error::from_reason("secret_key must be exactly 32 bytes"))?;

    for chunk_data in &chunks {
        let sealed = media_core::secret::seal_data(chunk_data.as_ref(), &key)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let buf: Buffer = sealed.into();
        on_chunk.call(buf)?;
    }

    Ok(())
}
