//! Shared helpers for fMP4 (fragmented MP4) parsing.
//! These are small, inlineable utilities used by both audio and video parsers.

use crate::fmp4::boxes::{Box_, MDAT, MDHD, MOOF, MOOV, read_box, read_u32};

/// Find the top-level `moov` box in the buffer.
#[inline]
pub(crate) fn find_moov(buf: &[u8]) -> Option<Box_> {
    let limit = buf.len();
    let mut pos = 0;
    while pos + 8 <= limit {
        let box_ = read_box(buf, pos, limit)?;
        if box_.type_ == MOOV {
            return Some(box_);
        }
        pos += box_.size;
        if pos + 8 > limit {
            break;
        }
    }
    None
}

/// Scan the children of a `moov` box to find the first `mdhd` box and
/// read its timescale. Falls back to `default_timescale` when parsing
/// fails or the box is missing.
#[inline]
pub(crate) fn read_mdhd_timescale(buf: &[u8], moov: &Box_, default_timescale: u32) -> u32 {
    let search_start = moov.payload_start;
    let search_end = moov.offset + moov.size;

    let mut timescale = default_timescale;
    let mut i = search_start + 4;
    while i + 16 <= search_end {
        match read_u32(buf, i) {
            Some(ty) if ty == MDHD => {
                let box_start = i - 4;
                let Some(box_size) = read_u32(buf, box_start) else {
                    break;
                };
                let box_size = box_size as usize;
                if box_size >= 24
                    && box_start + box_size <= search_end
                    && let Some(ver) = buf.get(i + 4)
                {
                    timescale = if *ver == 0 {
                        read_u32(buf, i + 4 + 12).unwrap_or(timescale)
                    } else {
                        read_u32(buf, i + 4 + 20).unwrap_or(timescale)
                    };
                }
                break;
            }
            Some(_) => {
                i += 1;
            }
            None => break,
        }
    }

    timescale
}

/// Find the first top-level `moof` and `mdat` boxes in the buffer.
#[inline]
pub(crate) fn find_moof_and_mdat(buf: &[u8]) -> Option<(Box_, Box_)> {
    let limit = buf.len();
    let mut pos = 0;
    let mut moof: Option<Box_> = None;
    let mut mdat: Option<Box_> = None;

    while pos + 8 <= limit {
        let box_ = read_box(buf, pos, limit)?;
        match box_.type_ {
            MOOF => moof = Some(box_),
            MDAT => mdat = Some(box_),
            _ => {}
        }
        pos += box_.size;
    }

    Some((moof?, mdat?))
}
