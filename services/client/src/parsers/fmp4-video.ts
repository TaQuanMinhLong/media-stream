/**
 * Minimal fMP4 parser for video: init segment (avcC) and media segments (moof+mdat → per-sample chunks).
 * Used so the TS layer stays a dumb pipe: bytes in → config + EncodedVideoChunk inputs out.
 */

/* ---------- Box type constants (big-endian uint32) ---------- */
const AVC_C = 0x61766343; // 'avcC'
const MOOF = 0x6d6f6f66;
const MOOV = 0x6d6f6f76;
const TRAF = 0x74726166;
const TFHD = 0x74666864;
const TFDT = 0x74666474;
const TRUN = 0x7472756e;
const MDAT = 0x6d646174;
const MDHD = 0x6d646864;

/* ---------- trun flags (ISO 14496-12 §8.8.8) ---------- */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

/* ---------- tfhd flags (ISO 14496-12 §8.8.7) ---------- */
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESC_INDEX = 0x000002;
const TFHD_DEFAULT_DURATION = 0x000008;
const TFHD_DEFAULT_SIZE = 0x000010;
const TFHD_DEFAULT_FLAGS = 0x000020;

function readU32(dv: DataView, offset: number): number {
  return dv.getUint32(offset, false);
}

function readI32(dv: DataView, offset: number): number {
  return dv.getInt32(offset, false);
}

function readU64(dv: DataView, offset: number): number {
  const hi = dv.getUint32(offset, false);
  const lo = dv.getUint32(offset + 4, false);
  return hi * 0x1_0000_0000 + lo;
}

interface Box {
  offset: number;
  size: number;
  type: number;
  payloadStart: number;
  payloadSize: number;
}

/** Read box at offset; supports 32-bit size, size=0 (to-end), and size=1 (64-bit). */
function readBox(buffer: ArrayBuffer, offset: number, limit: number): Box | null {
  const dv = new DataView(buffer);
  if (offset + 8 > limit || offset + 8 > buffer.byteLength) return null;
  let size = readU32(dv, offset);
  const type = readU32(dv, offset + 4);
  let headerSize = 8;
  if (size === 0) {
    size = limit - offset;
  } else if (size === 1) {
    if (offset + 16 > limit || offset + 16 > buffer.byteLength) return null;
    size = Number(readU64(dv, offset + 8));
    headerSize = 16;
  }
  if (size < 8 || offset + size > limit || offset + size > buffer.byteLength) return null;
  return { offset, size, type, payloadStart: offset + headerSize, payloadSize: size - headerSize };
}

/* ---------- Init segment parsing ---------- */

/** Result of parsing an init segment: avcC codec description for VideoDecoder.configure(). */
export interface VideoInitResult {
  /** avcC box payload (SPS/PPS etc.). Pass as description to VideoDecoder.configure(). */
  description: Uint8Array;
  /** Codec string e.g. "avc1.42E01E". */
  codec: string;
  /** Track timescale from mdhd (samples per second). Default 12800 if not found. */
  timescale: number;
}

/**
 * Parse video init segment (e.g. init-0.mp4) to extract avcC for VideoDecoder.
 * Walks moov to find mdhd (for timescale) and avcC (for codec description).
 */
export function parseVideoInit(initBuffer: ArrayBuffer): VideoInitResult | null {
  const dv = new DataView(initBuffer);
  const limit = initBuffer.byteLength;
  let pos = 0;
  let moov: Box | null = null;
  while (pos + 8 <= limit) {
    const box = readBox(initBuffer, pos, limit);
    if (!box) break;
    if (box.type === MOOV) {
      moov = box;
      break;
    }
    pos += box.size;
  }
  if (!moov) return null;

  const searchStart = moov.payloadStart;
  const searchEnd = moov.offset + moov.size;

  // Find timescale from mdhd (linear scan for the type tag)
  let timescale = 12800;
  for (let i = searchStart + 4; i + 16 <= searchEnd; i++) {
    if (readU32(dv, i) === MDHD) {
      const boxStart = i - 4;
      const boxSize = readU32(dv, boxStart);
      if (boxSize >= 24 && boxStart + boxSize <= searchEnd) {
        const ver = dv.getUint8(i + 4);
        if (ver === 0) {
          // version(1) + flags(3) + created(4) + modified(4) = 12 bytes, then timescale
          timescale = readU32(dv, i + 4 + 12);
        } else {
          // version(1) + flags(3) + created(8) + modified(8) = 20 bytes, then timescale
          timescale = readU32(dv, i + 4 + 20);
        }
      }
      break;
    }
  }

  // Find avcC anywhere inside moov
  for (let i = searchStart + 4; i + 4 <= searchEnd; i++) {
    if (readU32(dv, i) === AVC_C) {
      const boxStart = i - 4;
      const boxSize = readU32(dv, boxStart);
      if (boxStart < searchStart || boxSize < 8 || boxStart + boxSize > searchEnd) continue;
      const descLen = boxSize - 8;
      const payloadStart = i + 4;
      if (payloadStart + descLen > searchEnd || descLen < 4) continue;
      const description = new Uint8Array(initBuffer.slice(payloadStart, payloadStart + descLen));
      const profile = description[1]!;
      const compat = description[2]!;
      const level = description[3]!;
      const codec =
        "avc1." +
        [profile, compat, level]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
      return { description, codec, timescale };
    }
  }
  return null;
}

/* ---------- Media segment parsing ---------- */

/** One sample to feed to VideoDecoder as EncodedVideoChunk. */
export interface VideoSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  isKey: boolean;
}

/** Result of parsing a video media segment (chunk-0-*.m4s). */
export interface VideoMediaResult {
  baseDecodeTimeUs: number;
  samples: VideoSample[];
}

/** Defaults extracted from the Track Fragment Header (tfhd) box. */
interface TfhdDefaults {
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
}

/** Parse tfhd box to extract default sample duration/size/flags. */
function parseTfhd(dv: DataView, box: Box): TfhdDefaults {
  const result: TfhdDefaults = {
    defaultSampleDuration: 0,
    defaultSampleSize: 0,
    defaultSampleFlags: 0,
  };
  if (box.payloadSize < 8) return result;

  // FullBox: version(1) + flags(3) at payloadStart, then track_id(4)
  const flags =
    (dv.getUint8(box.payloadStart + 1) << 16) |
    (dv.getUint8(box.payloadStart + 2) << 8) |
    dv.getUint8(box.payloadStart + 3);

  let p = box.payloadStart + 4 + 4; // skip version+flags(4) + track_id(4)
  const boxEnd = box.offset + box.size;

  if (flags & TFHD_BASE_DATA_OFFSET) p += 8;
  if (flags & TFHD_SAMPLE_DESC_INDEX) p += 4;
  if (flags & TFHD_DEFAULT_DURATION) {
    if (p + 4 <= boxEnd) {
      result.defaultSampleDuration = readU32(dv, p);
      p += 4;
    }
  }
  if (flags & TFHD_DEFAULT_SIZE) {
    if (p + 4 <= boxEnd) {
      result.defaultSampleSize = readU32(dv, p);
      p += 4;
    }
  }
  if (flags & TFHD_DEFAULT_FLAGS) {
    if (p + 4 <= boxEnd) {
      result.defaultSampleFlags = readU32(dv, p);
    }
  }
  return result;
}

/**
 * Parse video media segment (moof + mdat) into per-sample chunks with timestamps.
 * Uses tfhd for defaults, tfdt for base decode time, trun for per-sample info.
 * @param timescale Track timescale from init segment.
 */
export function parseVideoMedia(
  segmentBuffer: ArrayBuffer,
  timescale = 12800,
): VideoMediaResult | null {
  const dv = new DataView(segmentBuffer);
  const limit = segmentBuffer.byteLength;

  // Find moof and mdat (skip styp, sidx, etc.)
  let pos = 0;
  let moof: Box | null = null;
  let mdat: Box | null = null;
  while (pos + 8 <= limit) {
    const box = readBox(segmentBuffer, pos, limit);
    if (!box) break;
    if (box.type === MOOF) moof = box;
    else if (box.type === MDAT) mdat = box;
    pos += box.size;
  }
  if (!moof || !mdat) return null;

  let baseDecodeTime = 0; // in timescale units
  let sampleCount = 0;
  let dataOffset = mdat.payloadStart; // fallback if trun has no data_offset
  const sampleSizes: number[] = [];
  const sampleDurations: number[] = [];
  const sampleCTOs: number[] = [];
  const sampleKeyFlags: boolean[] = [];
  let tfhd: TfhdDefaults = { defaultSampleDuration: 0, defaultSampleSize: 0, defaultSampleFlags: 0 };
  let firstSampleFlags = -1; // -1 = not set

  // Parse traf inside moof
  const moofEnd = moof.offset + moof.size;
  let trafStart = moof.payloadStart;
  while (trafStart + 8 <= moofEnd) {
    const trafBox = readBox(segmentBuffer, trafStart, moofEnd);
    if (!trafBox) break;
    if (trafBox.type !== TRAF) {
      trafStart += trafBox.size;
      continue;
    }
    const trafEnd = trafBox.offset + trafBox.size;
    let inner = trafBox.payloadStart;
    while (inner + 8 <= trafEnd) {
      const childBox = readBox(segmentBuffer, inner, trafEnd);
      if (!childBox) break;
      const boxEnd = childBox.offset + childBox.size;

      if (childBox.type === TFHD) {
        tfhd = parseTfhd(dv, childBox);
      } else if (childBox.type === TFDT && childBox.payloadSize >= 4) {
        // FullBox: version(1) + flags(3) at payloadStart, then baseMediaDecodeTime
        const ver = dv.getUint8(childBox.payloadStart);
        if (ver === 0 && childBox.payloadSize >= 8) {
          baseDecodeTime = readU32(dv, childBox.payloadStart + 4);
        } else if (childBox.payloadSize >= 12) {
          baseDecodeTime = Number(readU64(dv, childBox.payloadStart + 4));
        }
      } else if (childBox.type === TRUN && childBox.payloadSize >= 8) {
        // FullBox: version(1) + flags(3) at payloadStart
        const flags =
          (dv.getUint8(childBox.payloadStart + 1) << 16) |
          (dv.getUint8(childBox.payloadStart + 2) << 8) |
          dv.getUint8(childBox.payloadStart + 3);

        let p = childBox.payloadStart + 4; // after version+flags

        // sample_count comes FIRST (ISO 14496-12 §8.8.8)
        if (p + 4 > boxEnd) {
          inner = boxEnd;
          continue;
        }
        const rawCount = readU32(dv, p);
        p += 4;
        const MAX_TRUN_SAMPLES = 10000;
        sampleCount = Math.min(rawCount, MAX_TRUN_SAMPLES);

        // THEN optional data_offset and first_sample_flags
        if (flags & TRUN_DATA_OFFSET) {
          if (p + 4 > boxEnd) {
            inner = boxEnd;
            continue;
          }
          // data_offset is signed, relative to the start of the moof box
          const signedOffset = readI32(dv, p);
          p += 4;
          dataOffset = moof.offset + signedOffset;
        }
        if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
          if (p + 4 > boxEnd) {
            inner = boxEnd;
            continue;
          }
          firstSampleFlags = readU32(dv, p);
          p += 4;
        }

        // Per-sample data
        const hasDuration = (flags & TRUN_SAMPLE_DURATION) !== 0;
        const hasSize = (flags & TRUN_SAMPLE_SIZE) !== 0;
        const hasFlags = (flags & TRUN_SAMPLE_FLAGS) !== 0;
        const hasCTO = (flags & TRUN_SAMPLE_CTO) !== 0;

        for (let i = 0; i < sampleCount; i++) {
          let dur = tfhd.defaultSampleDuration;
          let sz = tfhd.defaultSampleSize;
          let sf =
            i === 0 && firstSampleFlags >= 0
              ? firstSampleFlags
              : tfhd.defaultSampleFlags;
          let cto = 0;

          if (hasDuration) {
            if (p + 4 > boxEnd) break;
            dur = readU32(dv, p);
            p += 4;
          }
          if (hasSize) {
            if (p + 4 > boxEnd) break;
            sz = readU32(dv, p);
            p += 4;
          }
          if (hasFlags) {
            if (p + 4 > boxEnd) break;
            sf = readU32(dv, p);
            p += 4;
          }
          if (hasCTO) {
            if (p + 4 > boxEnd) break;
            cto = readI32(dv, p);
            p += 4;
          }

          sampleDurations.push(dur);
          sampleSizes.push(sz);
          sampleCTOs.push(cto);
          // is_non_sync_sample is bit 16 of sample_flags
          sampleKeyFlags.push((sf & 0x00010000) === 0);
        }
      }
      inner = boxEnd;
    }
    break; // process only first traf
  }

  if (sampleSizes.length === 0) return null;

  const safeCount = Math.min(sampleCount, sampleSizes.length, sampleDurations.length);
  if (safeCount <= 0) return null;

  const samples: VideoSample[] = [];
  let byteOffset = dataOffset;
  let decodeTime = baseDecodeTime; // in timescale units
  const baseDecodeTimeUs = (baseDecodeTime * 1_000_000) / timescale;

  for (let i = 0; i < safeCount; i++) {
    const size = sampleSizes[i]!;
    if (size <= 0 || !Number.isInteger(size)) break;
    if (byteOffset < 0 || byteOffset + size > segmentBuffer.byteLength) break;

    const data = new Uint8Array(segmentBuffer.slice(byteOffset, byteOffset + size));
    const dur = sampleDurations[i]!;
    const cto = sampleCTOs[i] ?? 0;

    // PTS = DTS + composition_time_offset (all in timescale units)
    const pts = decodeTime + cto;
    const timestampUs = (pts * 1_000_000) / timescale;
    const durationUs = (dur * 1_000_000) / timescale;

    samples.push({
      data,
      timestampUs,
      durationUs,
      isKey: sampleKeyFlags[i] ?? i === 0,
    });

    decodeTime += dur;
    byteOffset += size;
  }

  return { baseDecodeTimeUs, samples };
}

/** Class-based video fMP4 parser; same interface can be implemented by Rust/WASM later. */
export class Fmp4VideoParser {
  parseInit(initBuffer: ArrayBuffer): VideoInitResult | null {
    return parseVideoInit(initBuffer);
  }

  parseMedia(segmentBuffer: ArrayBuffer, timescale: number): VideoMediaResult | null {
    return parseVideoMedia(segmentBuffer, timescale);
  }
}
