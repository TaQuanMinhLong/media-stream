//! Minimal fMP4 parser for audio: init (mp4a sample entry) and media (moof+mdat).
//! Reference: services/client/src/_reference/parsers/fmp4-audio.ts

use crate::fmp4::boxes::{
    Box_, MDAT, MDHD, MOOF, MOOV, MP4A, TFDT, TFHD, TRAF, TRUN, read_box, read_i32, read_u16,
    read_u32, read_u64,
};

const DEFAULT_TIMESCALE: u32 = 44100;

const TRUN_DATA_OFFSET: u32 = 0x0000_0001;
const TRUN_FIRST_SAMPLE_FLAGS: u32 = 0x0000_0004;
const TRUN_SAMPLE_DURATION: u32 = 0x0000_0100;
const TRUN_SAMPLE_SIZE: u32 = 0x0000_0200;
const TRUN_SAMPLE_FLAGS: u32 = 0x0000_0400;
const TRUN_SAMPLE_CTO: u32 = 0x0000_0800;

const TFHD_BASE_DATA_OFFSET: u32 = 0x0000_0001;
const TFHD_SAMPLE_DESC_INDEX: u32 = 0x0000_0002;
const TFHD_DEFAULT_DURATION: u32 = 0x0000_0008;
const TFHD_DEFAULT_SIZE: u32 = 0x0000_0010;

const MAX_TRUN_SAMPLES: usize = 10000;

/// Result of parsing an audio init segment: sample rate, channels, codec, timescale.
#[derive(Debug, Clone)]
pub struct AudioInitResult {
    pub sample_rate: u32,
    pub number_of_channels: u16,
    pub codec: String,
    pub timescale: u32,
}

/// One audio sample to feed to AudioDecoder.
#[derive(Debug, Clone)]
pub struct AudioSample {
    pub data: Vec<u8>,
    pub timestamp_us: u64,
    pub duration_us: u64,
}

/// Result of parsing an audio media segment.
#[derive(Debug, Clone)]
pub struct AudioMediaResult {
    pub base_decode_time_us: u64,
    pub samples: Vec<AudioSample>,
}

/// Parse audio init segment to get mp4a sample entry and timescale.
pub fn parse_audio_init(init_buf: &[u8]) -> Option<AudioInitResult> {
    let limit = init_buf.len();
    let mut pos = 0;
    let moov = loop {
        let box_ = read_box(init_buf, pos, limit)?;
        if box_.type_ == MOOV {
            break box_;
        }
        pos += box_.size;
        if pos + 8 > limit {
            return None;
        }
    };

    let search_start = moov.payload_start;
    let search_end = moov.offset + moov.size;

    let mut timescale = DEFAULT_TIMESCALE;
    let mut i = search_start + 4;
    while i + 16 <= search_end {
        if read_u32(init_buf, i)? == MDHD {
            let box_start = i - 4;
            let box_size = read_u32(init_buf, box_start)? as usize;
            if box_size >= 24 && box_start + box_size <= search_end {
                let ver = init_buf.get(i + 4)?;
                timescale = if *ver == 0 {
                    read_u32(init_buf, i + 4 + 12)?
                } else {
                    read_u32(init_buf, i + 4 + 20)?
                };
            }
            break;
        }
        i += 1;
    }

    let mut i = search_start + 4;
    while i + 4 <= search_end {
        if read_u32(init_buf, i)? == MP4A {
            let box_start = i - 4;
            let box_size = read_u32(init_buf, box_start)? as usize;
            if box_start < search_start || box_size < 8 || box_start + box_size > search_end {
                i += 1;
                continue;
            }
            let payload_start = i + 4;
            let payload_len = box_size - 8;
            if payload_len < 28 {
                i += 1;
                continue;
            }
            let channels = read_u16(init_buf, payload_start + 16)?;
            let sample_rate_fixed = read_u32(init_buf, payload_start + 24)?;
            let sample_rate = sample_rate_fixed >> 16;
            if !(8000..=192000).contains(&sample_rate) || !(1..=8).contains(&channels) {
                i += 1;
                continue;
            }
            return Some(AudioInitResult {
                sample_rate,
                number_of_channels: channels,
                codec: "mp4a.40.2".to_string(),
                timescale,
            });
        }
        i += 1;
    }
    None
}

#[derive(Default)]
struct TfhdDefaults {
    default_sample_duration: u32,
    default_sample_size: u32,
}

fn parse_tfhd(buf: &[u8], box_: &Box_) -> TfhdDefaults {
    let mut result = TfhdDefaults::default();
    if box_.payload_size < 8 {
        return result;
    }
    let p = box_.payload_start;
    let box_end = box_.offset + box_.size;
    let flags = (buf.get(p + 1).copied().unwrap_or(0) as u32) << 16
        | (buf.get(p + 2).copied().unwrap_or(0) as u32) << 8
        | buf.get(p + 3).copied().unwrap_or(0) as u32;
    let mut pos = p + 4 + 4;
    if flags & TFHD_BASE_DATA_OFFSET != 0 {
        pos += 8;
    }
    if flags & TFHD_SAMPLE_DESC_INDEX != 0 {
        pos += 4;
    }
    if flags & TFHD_DEFAULT_DURATION != 0 && pos + 4 <= box_end {
        result.default_sample_duration = read_u32(buf, pos).unwrap_or(0);
        pos += 4;
    }
    if flags & TFHD_DEFAULT_SIZE != 0 && pos + 4 <= box_end {
        result.default_sample_size = read_u32(buf, pos).unwrap_or(0);
    }
    result
}

/// Parse audio media segment (moof + mdat) into per-sample chunks.
pub fn parse_audio_media(segment_buf: &[u8], timescale: u32) -> Option<AudioMediaResult> {
    let limit = segment_buf.len();
    let mut pos = 0;
    let mut moof = None;
    let mut mdat = None;
    while pos + 8 <= limit {
        let box_ = read_box(segment_buf, pos, limit)?;
        match box_.type_ {
            MOOF => moof = Some(box_),
            MDAT => mdat = Some(box_),
            _ => {}
        }
        pos += box_.size;
    }
    let moof = moof?;
    let mdat = mdat?;

    let mut base_decode_time: u64 = 0;
    let mut sample_count = 0usize;
    let mut data_offset = mdat.payload_start;
    let mut sample_sizes: Vec<u32> = Vec::new();
    let mut sample_durations: Vec<u32> = Vec::new();
    let mut tfhd = TfhdDefaults::default();

    let moof_end = moof.offset + moof.size;
    let mut traf_start = moof.payload_start;
    while traf_start + 8 <= moof_end {
        let traf_box = read_box(segment_buf, traf_start, moof_end)?;
        if traf_box.type_ != TRAF {
            traf_start += traf_box.size;
            continue;
        }
        let traf_end = traf_box.offset + traf_box.size;
        let mut inner = traf_box.payload_start;
        while inner + 8 <= traf_end {
            let child = read_box(segment_buf, inner, traf_end)?;
            let box_end = child.offset + child.size;

            if child.type_ == TFHD {
                tfhd = parse_tfhd(segment_buf, &child);
            } else if child.type_ == TFDT && child.payload_size >= 4 {
                let ver = segment_buf.get(child.payload_start).copied().unwrap_or(1);
                if ver == 0 && child.payload_size >= 8 {
                    base_decode_time = read_u32(segment_buf, child.payload_start + 4)? as u64;
                } else if child.payload_size >= 12 {
                    base_decode_time = read_u64(segment_buf, child.payload_start + 4)?;
                }
            } else if child.type_ == TRUN && child.payload_size >= 8 {
                let p = child.payload_start;
                let flags = (segment_buf.get(p + 1).copied().unwrap_or(0) as u32) << 16
                    | (segment_buf.get(p + 2).copied().unwrap_or(0) as u32) << 8
                    | segment_buf.get(p + 3).copied().unwrap_or(0) as u32;
                let mut pos = p + 4;

                if pos + 4 > box_end {
                    inner = box_end;
                    continue;
                }
                let raw_count = read_u32(segment_buf, pos).unwrap_or(0) as usize;
                pos += 4;
                sample_count = raw_count.min(MAX_TRUN_SAMPLES);

                if flags & TRUN_DATA_OFFSET != 0 {
                    if pos + 4 > box_end {
                        inner = box_end;
                        continue;
                    }
                    let signed_offset = read_i32(segment_buf, pos).unwrap_or(0);
                    pos += 4;
                    data_offset = (moof.offset as i64 + signed_offset as i64) as usize;
                }
                if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 && pos + 4 <= box_end {
                    pos += 4;
                }

                let has_duration = flags & TRUN_SAMPLE_DURATION != 0;
                let has_size = flags & TRUN_SAMPLE_SIZE != 0;
                let has_flags = flags & TRUN_SAMPLE_FLAGS != 0;
                let has_cto = flags & TRUN_SAMPLE_CTO != 0;

                for _ in 0..sample_count {
                    let mut dur = tfhd.default_sample_duration;
                    let mut sz = tfhd.default_sample_size;

                    if has_duration {
                        if pos + 4 > box_end {
                            break;
                        }
                        dur = read_u32(segment_buf, pos).unwrap_or(0);
                        pos += 4;
                    }
                    if has_size {
                        if pos + 4 > box_end {
                            break;
                        }
                        sz = read_u32(segment_buf, pos).unwrap_or(0);
                        pos += 4;
                    }
                    if has_flags {
                        pos += 4;
                    }
                    if has_cto {
                        pos += 4;
                    }

                    sample_durations.push(dur);
                    sample_sizes.push(sz);
                }
            }
            inner = box_end;
        }
        break;
    }

    if sample_sizes.is_empty() {
        return None;
    }
    let safe_count = sample_count
        .min(sample_sizes.len())
        .min(sample_durations.len());
    if safe_count == 0 {
        return None;
    }

    let timescale_u = timescale as u64;
    let base_decode_time_us = (base_decode_time * 1_000_000) / timescale_u;
    let mut samples = Vec::with_capacity(safe_count);
    let mut byte_offset = data_offset;
    let mut decode_time = base_decode_time;

    for i in 0..safe_count {
        let size = sample_sizes[i] as usize;
        if size == 0 || byte_offset + size > segment_buf.len() {
            break;
        }
        let data = segment_buf[byte_offset..byte_offset + size].to_vec();
        let dur = sample_durations[i];
        let timestamp_us = (decode_time * 1_000_000) / timescale_u;
        let duration_us = (dur as u64 * 1_000_000) / timescale_u;

        samples.push(AudioSample {
            data,
            timestamp_us,
            duration_us,
        });

        decode_time += dur as u64;
        byte_offset += size;
    }

    Some(AudioMediaResult {
        base_decode_time_us,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_audio_init, parse_audio_media};

    #[test]
    fn parse_audio_init_empty_returns_none() {
        assert!(parse_audio_init(&[]).is_none());
    }

    #[test]
    fn parse_audio_init_no_moov_returns_none() {
        let buf = [0u8; 64];
        assert!(parse_audio_init(&buf).is_none());
    }

    #[test]
    fn parse_audio_media_empty_returns_none() {
        assert!(parse_audio_media(&[], 44100).is_none());
    }

    #[test]
    fn parse_audio_media_no_moof_mdat_returns_none() {
        let buf = [0u8; 32];
        assert!(parse_audio_media(&buf, 44100).is_none());
    }
}
