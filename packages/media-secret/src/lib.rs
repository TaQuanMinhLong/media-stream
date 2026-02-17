use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Seal raw data into a steganographic WebP blob.
///
/// Calls `media_core::secret::seal_data` (compress → encrypt → embed in WebP).
#[napi(js_name = "sealData")]
pub fn seal_data_napi(data: &[u8], secret_key: &[u8]) -> Result<Uint8Array> {
    let key: [u8; 32] = secret_key
        .as_ref()
        .try_into()
        .map_err(|_| Error::from_reason("secret_key must be exactly 32 bytes"))?;

    let sealed =
        media_core::secret::seal_data(data, &key).map_err(|e| Error::from_reason(e.to_string()))?;

    Ok(sealed.into())
}

/// Derive a 32-byte key from session_id + salt using Argon2id.
#[napi(js_name = "deriveKey")]
pub fn derive_key_napi(session_id: String, salt: Uint8ArraySlice) -> Result<Uint8Array> {
    let key = media_core::secret::derive_key(session_id.as_bytes(), salt.as_ref())
        .map_err(|e| Error::from_reason(format!("key derivation failed: {e}")))?;
    Ok(key.into())
}
