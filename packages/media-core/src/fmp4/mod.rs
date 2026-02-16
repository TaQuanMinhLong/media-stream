//! fMP4 (fragmented MP4) parsing for video and audio.
//! Reference: services/client/src/_reference/parsers/

pub mod audio;
pub mod boxes;
pub mod video;

pub use audio::{
    AudioInitResult, AudioMediaResult, AudioSample, parse_audio_init, parse_audio_media,
};
pub use video::{
    VideoInitResult, VideoMediaResult, VideoSample, parse_video_init, parse_video_media,
};
