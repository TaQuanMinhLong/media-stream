use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};

const PLACEHOLDER: &[u8] = include_bytes!("./assets/placeholder.webp");

/// Errors from seal/open operations.
#[derive(Debug)]
pub enum SealError {
    Compression(std::io::Error),
    Encryption(chacha20poly1305::aead::Error),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Compression(e) => write!(f, "compression failed: {}", e),
            SealError::Encryption(e) => write!(f, "encryption failed: {}", e),
        }
    }
}

impl std::error::Error for SealError {}

/// Takes a WebP image and a secret, returns a new WebP with hidden,
/// compressed, and encrypted data.
pub fn seal_data(data: &[u8], secret_key: &[u8; 32]) -> Result<Vec<u8>, SealError> {
    // 1. Compress
    let compressed = zstd::encode_all(data, 3).map_err(SealError::Compression)?;

    // 2. Encrypt
    let cipher = ChaCha20Poly1305::new(secret_key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng); // 12 bytes
    let ciphertext = cipher
        .encrypt(&nonce, compressed.as_ref())
        .map_err(SealError::Encryption)?;

    // 3. Package and Append
    let mut final_payload = Vec::with_capacity(PLACEHOLDER.len() + 12 + ciphertext.len());
    final_payload.extend_from_slice(PLACEHOLDER);
    final_payload.extend_from_slice(&nonce); // Store nonce so we can decrypt later
    final_payload.extend_from_slice(&ciphertext);

    Ok(final_payload)
}

/// Finds the RIFF end marker, extracts the nonce, decrypts, and decompresses.
pub fn open_sealed_data(data: &[u8], secret_key: &[u8; 32]) -> Option<Vec<u8>> {
    // Find the end of the legitimate WebP image via RIFF header
    if data.len() < 12 || &data[0..4] != b"RIFF" {
        return None;
    }

    let riff_size = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
    let image_end = riff_size + 8;

    if data.len() <= image_end + 12 {
        return None;
    }

    // 1. Extract Nonce and Ciphertext
    let nonce_start = image_end;
    let ciphertext_start = nonce_start + 12;
    let nonce = Nonce::from_slice(&data[nonce_start..ciphertext_start]);
    let ciphertext = &data[ciphertext_start..];

    // 2. Decrypt
    let cipher = ChaCha20Poly1305::new(secret_key.into());
    let decrypted = cipher.decrypt(nonce, ciphertext).ok()?;

    // 3. Decompress
    zstd::decode_all(decrypted.as_slice()).ok()
}
