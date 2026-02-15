/**
 * Minimal fMP4 parser for audio: init (mp4a sample entry) and media (moof+mdat → per-sample).
 */

/* ---------- Box type constants (big-endian uint32) ---------- */
const MOOV = 0x6d6f6f76;
const MP4A = 0x6d703461;
const MOOF = 0x6d6f6f66;
const MDAT = 0x6d646174;
const TRAF = 0x74726166;
const TFHD = 0x74666864;
const TFDT = 0x74666474;
const TRUN = 0x7472756e;
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

export interface AudioInitResult {
  sampleRate: number;
  numberOfChannels: number;
  codec: string;
  /** Track timescale from mdhd (e.g. 44100). */
  timescale: number;
}

/**
 * Parse audio init segment (e.g. init-1.mp4) to get mp4a sample entry for AudioDecoder.
 * Also extracts the audio track timescale from mdhd.
 */
export function parseAudioInit(initBuffer: ArrayBuffer): AudioInitResult | null {
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

  // Find timescale from mdhd
  let timescale = 44100; // sensible default for audio
  for (let i = searchStart + 4; i + 16 <= searchEnd; i++) {
    if (readU32(dv, i) === MDHD) {
      const boxStart = i - 4;
      const boxSize = readU32(dv, boxStart);
      if (boxSize >= 24 && boxStart + boxSize <= searchEnd) {
        const ver = dv.getUint8(i + 4);
        if (ver === 0) {
          timescale = readU32(dv, i + 4 + 12);
        } else {
          timescale = readU32(dv, i + 4 + 20);
        }
      }
      break;
    }
  }

  // Find mp4a sample entry
  for (let i = searchStart + 4; i + 4 <= searchEnd; i++) {
    if (readU32(dv, i) === MP4A) {
      const boxStart = i - 4;
      const boxSize = readU32(dv, boxStart);
      if (boxStart < searchStart || boxSize < 8 || boxStart + boxSize > searchEnd) continue;
      const payloadStart = i + 4;
      const payloadLen = boxSize - 8;
      if (payloadLen < 28) continue;
      const channels = dv.getUint16(payloadStart + 16, false);
      const sampleRateFixed = readU32(dv, payloadStart + 24);
      const sampleRate = sampleRateFixed >>> 16;
      if (
        !Number.isInteger(sampleRate) ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 8
      ) {
        continue;
      }
      return { sampleRate, numberOfChannels: channels, codec: "mp4a.40.2", timescale };
    }
  }
  return null;
}

/* ---------- Media segment parsing ---------- */

export interface AudioSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

export interface AudioMediaResult {
  baseDecodeTimeUs: number;
  samples: AudioSample[];
}

/** Defaults extracted from the Track Fragment Header (tfhd) box. */
interface TfhdDefaults {
  defaultSampleDuration: number;
  defaultSampleSize: number;
}

/** Parse tfhd box to extract default sample duration/size. */
function parseTfhd(dv: DataView, box: Box): TfhdDefaults {
  const result: TfhdDefaults = { defaultSampleDuration: 0, defaultSampleSize: 0 };
  if (box.payloadSize < 8) return result;

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
    }
  }
  return result;
}

/**
 * Parse audio media segment (moof + mdat) into per-sample chunks with timestamps.
 * @param timescale Audio track timescale from init segment (e.g. 44100).
 */
export function parseAudioMedia(
  segmentBuffer: ArrayBuffer,
  timescale = 44100,
): AudioMediaResult | null {
  const dv = new DataView(segmentBuffer);
  const limit = segmentBuffer.byteLength;

  // Find moof and mdat
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
  let dataOffset = mdat.payloadStart; // fallback
  const sampleSizes: number[] = [];
  const sampleDurations: number[] = [];
  let tfhd: TfhdDefaults = { defaultSampleDuration: 0, defaultSampleSize: 0 };

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
        const ver = dv.getUint8(childBox.payloadStart);
        if (ver === 0 && childBox.payloadSize >= 8) {
          baseDecodeTime = readU32(dv, childBox.payloadStart + 4);
        } else if (childBox.payloadSize >= 12) {
          baseDecodeTime = Number(readU64(dv, childBox.payloadStart + 4));
        }
      } else if (childBox.type === TRUN && childBox.payloadSize >= 8) {
        const flags =
          (dv.getUint8(childBox.payloadStart + 1) << 16) |
          (dv.getUint8(childBox.payloadStart + 2) << 8) |
          dv.getUint8(childBox.payloadStart + 3);

        let p = childBox.payloadStart + 4; // after version+flags

        // sample_count comes FIRST
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
          const signedOffset = readI32(dv, p);
          p += 4;
          dataOffset = moof.offset + signedOffset;
        }
        if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
          if (p + 4 > boxEnd) {
            inner = boxEnd;
            continue;
          }
          p += 4; // skip first_sample_flags (not used for audio keyframe detection)
        }

        // Per-sample data
        const hasDuration = (flags & TRUN_SAMPLE_DURATION) !== 0;
        const hasSize = (flags & TRUN_SAMPLE_SIZE) !== 0;
        const hasFlags = (flags & TRUN_SAMPLE_FLAGS) !== 0;
        const hasCTO = (flags & TRUN_SAMPLE_CTO) !== 0;

        for (let i = 0; i < sampleCount; i++) {
          let dur = tfhd.defaultSampleDuration;
          let sz = tfhd.defaultSampleSize;

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
            p += 4; // skip per-sample flags
          }
          if (hasCTO) {
            if (p + 4 > boxEnd) break;
            p += 4; // skip composition time offset (not typical for audio)
          }

          sampleDurations.push(dur);
          sampleSizes.push(sz);
        }
      }
      inner = boxEnd;
    }
    break; // process only first traf
  }

  if (sampleSizes.length === 0) return null;

  const safeCount = Math.min(sampleCount, sampleSizes.length, sampleDurations.length);
  if (safeCount <= 0) return null;

  const samples: AudioSample[] = [];
  let byteOffset = dataOffset;
  let decodeTime = baseDecodeTime; // in timescale units
  const baseDecodeTimeUs = (baseDecodeTime * 1_000_000) / timescale;

  for (let i = 0; i < safeCount; i++) {
    const size = sampleSizes[i]!;
    if (size <= 0 || !Number.isInteger(size)) break;
    if (byteOffset < 0 || byteOffset + size > segmentBuffer.byteLength) break;

    const data = new Uint8Array(segmentBuffer.slice(byteOffset, byteOffset + size));
    const dur = sampleDurations[i]!;
    const timestampUs = (decodeTime * 1_000_000) / timescale;
    const durationUs = (dur * 1_000_000) / timescale;

    samples.push({ data, timestampUs, durationUs });

    decodeTime += dur;
    byteOffset += size;
  }

  return { baseDecodeTimeUs, samples };
}
