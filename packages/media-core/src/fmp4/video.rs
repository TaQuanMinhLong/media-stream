//! Minimal fMP4 parser for video: init segment (avcC) and media segments (moof+mdat).
//! Reference: services/client/src/_reference/parsers/fmp4-video.ts

use crate::fmp4::{
    boxes::{AVC_C, Box_, TFDT, TFHD, TRAF, TRUN, read_box, read_i32, read_u32, read_u64},
    common::{find_moof_and_mdat, find_moov, read_mdhd_timescale},
};

const DEFAULT_TIMESCALE: u32 = 12800;

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
const TFHD_DEFAULT_FLAGS: u32 = 0x0000_0020;

const MAX_TRUN_SAMPLES: usize = 10000;

/// Result of parsing a video init segment: avcC codec description for VideoDecoder.
#[derive(Debug, Clone)]
pub struct VideoInitResult {
    pub description: Vec<u8>,
    pub codec: String,
    pub timescale: u32,
}

/// One sample to feed to VideoDecoder as EncodedVideoChunk.
#[derive(Debug, Clone)]
pub struct VideoSample {
    pub data: Vec<u8>,
    pub timestamp_us: u64,
    pub duration_us: u64,
    pub is_key: bool,
}

/// Result of parsing a video media segment.
#[derive(Debug, Clone)]
pub struct VideoMediaResult {
    pub base_decode_time_us: u64,
    pub samples: Vec<VideoSample>,
}

/// Parse video init segment to extract avcC for VideoDecoder.
pub fn parse_video_init(init_buf: &[u8]) -> Option<VideoInitResult> {
    let moov = find_moov(init_buf)?;
    let search_start = moov.payload_start;
    let search_end = moov.offset + moov.size;

    let timescale = read_mdhd_timescale(init_buf, &moov, DEFAULT_TIMESCALE);

    let mut i = search_start + 4;
    while i + 4 <= search_end {
        if read_u32(init_buf, i)? == AVC_C {
            let box_start = i - 4;
            let box_size = read_u32(init_buf, box_start)? as usize;
            if box_start < search_start || box_size < 8 || box_start + box_size > search_end {
                i += 1;
                continue;
            }
            let desc_len = box_size - 8;
            let payload_start = i + 4;
            if payload_start + desc_len > search_end || desc_len < 4 {
                i += 1;
                continue;
            }
            let description = init_buf[payload_start..payload_start + desc_len].to_vec();
            let profile = description.get(1).copied().unwrap_or(0);
            let compat = description.get(2).copied().unwrap_or(0);
            let level = description.get(3).copied().unwrap_or(0);
            let codec = format!("avc1.{:02X}{:02X}{:02X}", profile, compat, level);
            return Some(VideoInitResult {
                description,
                codec,
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
    default_sample_flags: u32,
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
        pos += 4;
    }
    if flags & TFHD_DEFAULT_FLAGS != 0 && pos + 4 <= box_end {
        result.default_sample_flags = read_u32(buf, pos).unwrap_or(0);
    }
    result
}

/// Parse video media segment (moof + mdat) into per-sample chunks.
pub fn parse_video_media(segment_buf: &[u8], timescale: u32) -> Option<VideoMediaResult> {
    let (moof, mdat) = find_moof_and_mdat(segment_buf)?;

    let (
        base_decode_time,
        sample_count,
        data_offset,
        sample_sizes,
        sample_durations,
        sample_ctos,
        sample_key_flags,
    ) = parse_video_traf_and_trun(segment_buf, &moof, &mdat)?;

    let timescale_u = timescale as u64;
    let base_decode_time_us = (base_decode_time * 1_000_000) / timescale_u;
    let mut samples = Vec::with_capacity(sample_count);
    let mut byte_offset = data_offset;
    let mut decode_time = base_decode_time;

    for i in 0..sample_count {
        let size = sample_sizes[i] as usize;
        if size == 0 || byte_offset + size > segment_buf.len() {
            break;
        }
        let data = segment_buf[byte_offset..byte_offset + size].to_vec();
        let dur = sample_durations[i];
        let cto = sample_ctos.get(i).copied().unwrap_or(0);
        let pts = (decode_time as i64) + (cto as i64);
        let timestamp_us = ((pts.max(0) as u64) * 1_000_000) / timescale_u;
        let duration_us = (dur as u64 * 1_000_000) / timescale_u;
        let is_key = sample_key_flags.get(i).copied().unwrap_or(i == 0);

        samples.push(VideoSample {
            data,
            timestamp_us,
            duration_us,
            is_key,
        });

        decode_time += dur as u64;
        byte_offset += size;
    }

    Some(VideoMediaResult {
        base_decode_time_us,
        samples,
    })
}

#[inline]
fn parse_video_traf_and_trun(
    segment_buf: &[u8],
    moof: &Box_,
    mdat: &Box_,
) -> Option<(
    u64,       // base_decode_time
    usize,     // safe_count
    usize,     // data_offset
    Vec<u32>,  // sample_sizes
    Vec<u32>,  // sample_durations
    Vec<i32>,  // sample_ctos
    Vec<bool>, // sample_key_flags
)> {
    let mut base_decode_time: u64 = 0;
    let mut sample_count = 0usize;
    let mut data_offset = mdat.payload_start;
    let mut sample_sizes: Vec<u32> = Vec::new();
    let mut sample_durations: Vec<u32> = Vec::new();
    let mut sample_ctos: Vec<i32> = Vec::new();
    let mut sample_key_flags: Vec<bool> = Vec::new();
    let mut tfhd = TfhdDefaults::default();
    let mut first_sample_flags: i32 = -1;

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
                    base_decode_time = match read_u32(segment_buf, child.payload_start + 4) {
                        Some(v) => v as u64,
                        None => return None,
                    };
                } else if child.payload_size >= 12 {
                    base_decode_time = match read_u64(segment_buf, child.payload_start + 4) {
                        Some(v) => v,
                        None => return None,
                    };
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
                if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 {
                    if pos + 4 > box_end {
                        inner = box_end;
                        continue;
                    }
                    first_sample_flags = read_u32(segment_buf, pos).unwrap_or(0) as i32;
                    pos += 4;
                }

                let has_duration = flags & TRUN_SAMPLE_DURATION != 0;
                let has_size = flags & TRUN_SAMPLE_SIZE != 0;
                let has_flags = flags & TRUN_SAMPLE_FLAGS != 0;
                let has_cto = flags & TRUN_SAMPLE_CTO != 0;

                for i in 0..sample_count {
                    let mut dur = tfhd.default_sample_duration;
                    let mut sz = tfhd.default_sample_size;
                    let mut sf = if i == 0 && first_sample_flags >= 0 {
                        first_sample_flags as u32
                    } else {
                        tfhd.default_sample_flags
                    };
                    let mut cto = 0i32;

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
                        if pos + 4 > box_end {
                            break;
                        }
                        sf = read_u32(segment_buf, pos).unwrap_or(0);
                        pos += 4;
                    }
                    if has_cto {
                        if pos + 4 > box_end {
                            break;
                        }
                        cto = read_i32(segment_buf, pos).unwrap_or(0);
                        pos += 4;
                    }

                    sample_durations.push(dur);
                    sample_sizes.push(sz);
                    sample_ctos.push(cto);
                    sample_key_flags.push((sf & 0x0001_0000) == 0);
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

    let safe_count = safe_count;
    Some((
        base_decode_time,
        safe_count,
        data_offset,
        sample_sizes,
        sample_durations,
        sample_ctos,
        sample_key_flags,
    ))
}

#[cfg(test)]
mod tests {
    use super::{parse_video_init, parse_video_media};

    #[test]
    fn parse_video_init_empty_returns_none() {
        assert!(parse_video_init(&[]).is_none());
    }

    #[test]
    fn parse_video_init_no_moov_returns_none() {
        let buf = [0u8; 64];
        assert!(parse_video_init(&buf).is_none());
    }

    #[test]
    fn parse_video_media_empty_returns_none() {
        assert!(parse_video_media(&[], 12800).is_none());
    }

    #[test]
    fn parse_video_media_no_moof_mdat_returns_none() {
        let buf = [0u8; 32];
        assert!(parse_video_media(&buf, 12800).is_none());
    }
}
