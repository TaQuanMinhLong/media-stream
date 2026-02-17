//! Encryption, decryption, and key derivation for the steganographic WebP pipeline.
//!
//! - **Server (NAPI)**: enable the `seal` feature for `seal_data` (compress + encrypt + embed).
//! - **Worker (WASM)**: default features give `open_sealed_data` (decrypt + decompress)
//!   and `derive_key`, using pure-Rust `ruzstd` for decompression so no C deps are needed.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};

#[cfg(feature = "seal")]
use chacha20poly1305::aead::{AeadCore, OsRng};

#[cfg(feature = "seal")]
const PLACEHOLDER: &[u8] = include_bytes!("./assets/placeholder.webp");

// ── Argon2id parameters (MUST match between server and client) ──────────────
pub const ARGON2_M_COST: u32 = 4096; // 4 MiB memory
pub const ARGON2_T_COST: u32 = 3; // 3 iterations
pub const ARGON2_P_COST: u32 = 1; // 1 thread (WASM compatible)
pub const ARGON2_OUTPUT_LEN: usize = 32; // 32 bytes for ChaCha20-Poly1305

/// Errors from seal/open operations.
#[derive(Debug)]
pub enum SealError {
    Compression(std::io::Error),
    Encryption(chacha20poly1305::aead::Error),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Compression(e) => write!(f, "compression failed: {e}"),
            SealError::Encryption(e) => write!(f, "encryption failed: {e}"),
        }
    }
}

impl std::error::Error for SealError {}

/// Derive a 32-byte secret key from `session_id` + `salt` using Argon2id.
///
/// Both server (NAPI) and client (WASM worker) call this with the same
/// parameters so they arrive at the same key without it ever crossing the wire.
pub fn derive_key(session_id: &[u8], salt: &[u8]) -> Result<[u8; 32], argon2::Error> {
    use argon2::{Algorithm, Argon2, Params, Version};

    let params = Params::new(
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
        Some(ARGON2_OUTPUT_LEN),
    )?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2.hash_password_into(session_id, salt, &mut key)?;
    Ok(key)
}

/// Seal raw data: compress (zstd C) → encrypt (ChaCha20-Poly1305) → append to WebP placeholder.
///
/// Returns `base_webp || nonce (12 B) || ciphertext+tag`.
///
/// Only available with the `seal` feature (native builds).
#[cfg(feature = "seal")]
pub fn seal_data(data: &[u8], secret_key: &[u8; 32]) -> Result<Vec<u8>, SealError> {
    let compressed = zstd::encode_all(data, 3).map_err(SealError::Compression)?;

    let cipher = ChaCha20Poly1305::new(secret_key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, compressed.as_ref())
        .map_err(SealError::Encryption)?;

    let mut payload = Vec::with_capacity(PLACEHOLDER.len() + 12 + ciphertext.len());
    payload.extend_from_slice(PLACEHOLDER);
    payload.extend_from_slice(&nonce);
    payload.extend_from_slice(&ciphertext);

    Ok(payload)
}

#[derive(Debug)]
pub enum OpenSealedDataError {
    InvalidWebp,
    NotEnoughData,
    MalformedData,
    DecryptionFailed(chacha20poly1305::aead::Error),
    FrameDecoderError(ruzstd::decoding::errors::FrameDecoderError),
    DecompressionFailed(std::io::Error),
}

impl std::fmt::Display for OpenSealedDataError {
    #[inline]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenSealedDataError::InvalidWebp => write!(f, "invalid WebP file"),
            OpenSealedDataError::NotEnoughData => write!(f, "not enough data"),
            OpenSealedDataError::MalformedData => write!(f, "malformed data"),
            OpenSealedDataError::DecryptionFailed(e) => write!(f, "decryption failed: {e}"),
            OpenSealedDataError::FrameDecoderError(e) => write!(f, "frame decoder error: {e}"),
            OpenSealedDataError::DecompressionFailed(e) => write!(f, "decompression failed: {e}"),
        }
    }
}

/// Open a sealed WebP blob: parse RIFF end → extract nonce + ciphertext →
/// decrypt (ChaCha20-Poly1305) → decompress (pure-Rust ruzstd).
///
/// Returns `None` if the data is malformed or authentication fails.
pub fn open_sealed_data(
    data: &[u8],
    secret_key: &[u8; 32],
) -> Result<Vec<u8>, OpenSealedDataError> {
    if data.len() < 12 || &data[0..4] != b"RIFF" {
        return Err(OpenSealedDataError::InvalidWebp);
    }

    let riff_size = u32::from_le_bytes(
        data[4..8]
            .try_into()
            .map_err(|_| OpenSealedDataError::MalformedData)?,
    ) as usize;
    let image_end = riff_size + 8;

    if data.len() <= image_end + 12 {
        return Err(OpenSealedDataError::NotEnoughData);
    }

    let nonce = Nonce::from_slice(&data[image_end..image_end + 12]);
    let ciphertext = &data[image_end + 12..];

    let cipher = ChaCha20Poly1305::new(secret_key.into());
    let decrypted = cipher
        .decrypt(nonce, ciphertext)
        .map_err(OpenSealedDataError::DecryptionFailed)?;

    // Decompress with pure-Rust ruzstd (WASM-safe)
    use std::io::Read;
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(decrypted.as_slice())
        .map_err(OpenSealedDataError::FrameDecoderError)?;
    let mut output = Vec::new();

    decoder
        .read_to_end(&mut output)
        .map_err(OpenSealedDataError::DecompressionFailed)?;
    Ok(output)
}

#[cfg(all(test, feature = "seal"))]
mod tests {
    use super::{derive_key, open_sealed_data, seal_data};

    #[test]
    fn round_trip_seal_open() {
        let session_id = b"test-session-id";
        let salt = b"random_salt_16b";
        let key = derive_key(session_id, salt).expect("derive_key");
        let data = b"hello world fMP4 segment data";
        let sealed = seal_data(data, &key).expect("seal_data");
        assert!(
            sealed.starts_with(b"RIFF"),
            "sealed should start with RIFF header"
        );
        let opened = open_sealed_data(&sealed, &key).expect("open_sealed_data");
        assert_eq!(
            opened.as_slice(),
            data,
            "round-trip should recover original"
        );
    }

    #[test]
    fn round_trip_large_data() {
        let key = [42u8; 32];
        let data: Vec<u8> = (0..50_000).map(|i| (i % 256) as u8).collect();
        let sealed = seal_data(&data, &key).expect("seal_data");
        let opened = open_sealed_data(&sealed, &key).expect("open_sealed_data");
        assert_eq!(opened, data, "large data round-trip");
    }

    #[test]
    fn wrong_key_fails() {
        let key = [0u8; 32];
        let wrong_key = [1u8; 32];
        let data = b"secret";
        let sealed = seal_data(data, &key).expect("seal_data");
        assert!(
            open_sealed_data(&sealed, &wrong_key).is_err(),
            "wrong key must fail"
        );
    }
}

/// Returns `true` if the buffer looks like a sealed WebP (has RIFF header + appended payload).
#[inline]
pub fn is_sealed(data: &[u8]) -> bool {
    if data.len() < 12 || &data[0..4] != b"RIFF" {
        return false;
    }
    let riff_size = u32::from_le_bytes(match data[4..8].try_into() {
        Ok(b) => b,
        Err(_) => return false,
    }) as usize;
    let image_end = riff_size + 8;
    // Must have at least nonce (12 B) + some ciphertext after the RIFF image
    data.len() > image_end + 12
}
