//! Core logic for media streaming: seek-index, fMP4 parsing, message protocol,
//! and encryption/decryption (steganographic WebP pipeline).
//! No browser APIs; used by media-client, media-worker, and media-secret (NAPI).

pub mod fmp4;
pub mod secret;
pub mod seek_index;

pub use fmp4::{
    AudioInitResult, AudioMediaResult, AudioSample, VideoInitResult, VideoMediaResult, VideoSample,
    parse_audio_init, parse_audio_media, parse_video_init, parse_video_media,
};
pub use seek_index::{format_segment_url, time_to_segment_index};
