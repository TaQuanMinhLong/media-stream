//! ISO base media file format (ISO 14496-12) box reading.
//! Reference: services/client/src/_reference/parsers/fmp4-video.ts

use std::fmt;

#[derive(Clone, Copy)]
pub struct Box_ {
    pub offset: usize,
    pub size: usize,
    pub type_: u32,
    pub payload_start: usize,
    pub payload_size: usize,
}

impl fmt::Debug for Box_ {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Box")
            .field("offset", &self.offset)
            .field("size", &self.size)
            .field("type_", &format!("0x{:08x}", self.type_))
            .field("payload_start", &self.payload_start)
            .field("payload_size", &self.payload_size)
            .finish()
    }
}

// Box type constants (big-endian u32)
pub const AVC_C: u32 = 0x6176_6343; // 'avcC'
pub const MOOF: u32 = 0x6d6f_6f66;
pub const MOOV: u32 = 0x6d6f_6f76;
pub const TRAF: u32 = 0x7472_6166;
pub const TFHD: u32 = 0x7466_6864;
pub const TFDT: u32 = 0x7466_6474;
pub const TRUN: u32 = 0x7472_756e;
pub const MDAT: u32 = 0x6d64_6174;
pub const MDHD: u32 = 0x6d64_6864;
pub const MP4A: u32 = 0x6d70_3461; // audio

#[inline]
pub fn read_u16(buf: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > buf.len() {
        return None;
    }
    let b = &buf[offset..offset + 2];
    Some(u16::from_be_bytes([b[0], b[1]]))
}

#[inline]
pub fn read_u32(buf: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > buf.len() {
        return None;
    }
    let b = &buf[offset..offset + 4];
    Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

#[inline]
pub fn read_i32(buf: &[u8], offset: usize) -> Option<i32> {
    if offset + 4 > buf.len() {
        return None;
    }
    let b = &buf[offset..offset + 4];
    Some(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

#[inline]
pub fn read_u64(buf: &[u8], offset: usize) -> Option<u64> {
    if offset + 8 > buf.len() {
        return None;
    }
    let hi = read_u32(buf, offset)? as u64;
    let lo = read_u32(buf, offset + 4)? as u64;
    Some(hi << 32 | lo)
}

/// Read box at offset; supports 32-bit size, size=0 (to-end), and size=1 (64-bit).
pub fn read_box(buf: &[u8], offset: usize, limit: usize) -> Option<Box_> {
    if offset + 8 > limit || offset + 8 > buf.len() {
        return None;
    }
    let size = read_u32(buf, offset)? as usize;
    let type_ = read_u32(buf, offset + 4)?;
    let (size, header_size) = if size == 0 {
        (limit - offset, 8)
    } else if size == 1 {
        if offset + 16 > limit || offset + 16 > buf.len() {
            return None;
        }
        let size64 = read_u64(buf, offset + 8)?;
        (size64 as usize, 16)
    } else {
        (size, 8)
    };
    if size < 8 || offset + size > limit || offset + size > buf.len() {
        return None;
    }
    Some(Box_ {
        offset,
        size,
        type_,
        payload_start: offset + header_size,
        payload_size: size - header_size,
    })
}
