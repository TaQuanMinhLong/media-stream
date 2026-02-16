//! Core logic for media streaming: seek-index, fMP4 parsing, message protocol.
//! No browser APIs; used by both media-client and media-worker.

pub mod fmp4;
pub mod protocol;
pub mod seek_index;

pub use fmp4::{
    AudioInitResult, AudioMediaResult, AudioSample, VideoInitResult, VideoMediaResult, VideoSample,
    parse_audio_init, parse_audio_media, parse_video_init, parse_video_media,
};
pub use seek_index::{format_segment_url, time_to_segment_index};
