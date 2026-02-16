/**
 * Minimal fMP4 box builders for parser unit tests (no real media files needed).
 * All numeric fields are big-endian.
 */

const MOOV = 0x6d6f6f76;
const MDHD = 0x6d646864;
const AVC_C = 0x61766343;
const MP4A = 0x6d703461;
const MOOF = 0x6d6f6f66;
const MDAT = 0x6d646174;
const TRAF = 0x74726166;
const TFHD = 0x74666864;
const TFDT = 0x74666474;
const TRUN = 0x7472756e;

function setU32(dv: DataView, offset: number, val: number): void {
  dv.setUint32(offset, val, false);
}

function setType(dv: DataView, offset: number, fourcc: number): void {
  dv.setUint32(offset, fourcc, false);
}

/** Minimal video init: moov with mdhd (timescale 12800) + avcC (codec avc1.42E01E). */
export function buildMinimalVideoInit(): ArrayBuffer {
  // moov: [size 56][moov] [mdhd 32][avcC 16]
  const size = 56;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let pos = 0;
  setU32(dv, pos, size);
  pos += 4;
  setType(dv, pos, MOOV);
  pos += 4;
  // mdhd: 32 bytes total. size 32, 'mdhd', version 0, flags 0, created 0, modified 0, timescale 12800
  setU32(dv, pos, 32);
  pos += 4;
  setType(dv, pos, MDHD);
  pos += 4;
  dv.setUint8(pos, 0); // version
  pos += 4; // +3 flags
  setU32(dv, pos, 0); // created
  pos += 4;
  setU32(dv, pos, 0); // modified
  pos += 4;
  setU32(dv, pos, 12800); // timescale
  pos += 4;
  // avcC: 16 bytes. size 16, 'avcC', payload 4 bytes: 0, 0x42, 0xE0, 0x1E
  setU32(dv, pos, 16);
  pos += 4;
  setType(dv, pos, AVC_C);
  pos += 4;
  dv.setUint8(pos, 0);
  dv.setUint8(pos + 1, 0x42);
  dv.setUint8(pos + 2, 0xe0);
  dv.setUint8(pos + 3, 0x1e);
  return buf;
}

/** Minimal audio init: moov with mdhd (timescale 44100) + mp4a (2 ch, 44100 Hz). */
export function buildMinimalAudioInit(): ArrayBuffer {
  // moov: [size][moov] [mdhd 32] [mp4a with payload >= 28]
  // mp4a payload: 6 reserved, 2 data_ref, 2 ch, 2 bps, 2 ???, 4 ???, 4 sampleRate<<16
  const mdhdSize = 32;
  const mp4aPayload = 28;
  const mp4aSize = 8 + mp4aPayload;
  const moovSize = 8 + mdhdSize + mp4aSize;
  const buf = new ArrayBuffer(moovSize);
  const dv = new DataView(buf);
  let pos = 0;
  setU32(dv, pos, moovSize);
  pos += 4;
  setType(dv, pos, MOOV);
  pos += 4;
  setU32(dv, pos, mdhdSize);
  pos += 4;
  setType(dv, pos, MDHD);
  pos += 4;
  dv.setUint8(pos, 0);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, 44100); // timescale
  pos += 4;
  setU32(dv, pos, mp4aSize);
  pos += 4;
  setType(dv, pos, MP4A);
  pos += 4;
  pos += 16; // skip to offset 16 in payload
  dv.setUint16(pos, 2, false); // numberOfChannels
  pos += 2;
  pos += 6; // to offset 24
  dv.setUint32(pos, 44100 << 16, false); // sampleRate fixed 16.16
  return buf;
}

/** Minimal video media: moof (traf: tfhd, tfdt, trun) + mdat with one sample. */
export function buildMinimalVideoMedia(): ArrayBuffer {
  const sampleSize = 100;
  const sampleDuration = 64000; // timescale units
  const defaultFlags = 0; // key frame
  const tfhdSize = 32;
  const tfdtSize = 16;
  const trunSize = 36; // 8 + 4+4+4+4 (count, data_offset, first_flags) + 12 one sample
  const trafSize = 8 + tfhdSize + tfdtSize + trunSize;
  const moofSize = 8 + trafSize;
  const dataOffset = moofSize + 8;
  const mdatSize = 8 + sampleSize;
  const total = moofSize + mdatSize;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let pos = 0;

  setU32(dv, pos, moofSize);
  pos += 4;
  setType(dv, pos, MOOF);
  pos += 4;
  setU32(dv, pos, trafSize);
  pos += 4;
  setType(dv, pos, TRAF);
  pos += 4;
  setU32(dv, pos, tfhdSize);
  pos += 4;
  setType(dv, pos, TFHD);
  pos += 4;
  dv.setUint8(pos, 0);
  dv.setUint8(pos + 1, 0);
  dv.setUint8(pos + 2, 0);
  dv.setUint8(pos + 3, 0x38);
  pos += 4;
  setU32(dv, pos, 1);
  pos += 4;
  setU32(dv, pos, sampleDuration);
  pos += 4;
  setU32(dv, pos, sampleSize);
  pos += 4;
  setU32(dv, pos, defaultFlags);
  pos += 4;
  setU32(dv, pos, tfdtSize);
  pos += 4;
  setType(dv, pos, TFDT);
  pos += 4;
  dv.setUint8(pos, 0);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, trunSize);
  pos += 4;
  setType(dv, pos, TRUN);
  pos += 4;
  dv.setUint8(pos, 0);
  dv.setUint8(pos + 1, 0);
  dv.setUint8(pos + 2, 0x07);
  dv.setUint8(pos + 3, 0x05);
  pos += 4;
  setU32(dv, pos, 1);
  pos += 4;
  setU32(dv, pos, dataOffset);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, sampleDuration);
  pos += 4;
  setU32(dv, pos, sampleSize);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, mdatSize);
  pos += 4;
  setType(dv, pos, MDAT);
  pos += 4;
  for (let i = 0; i < sampleSize; i++) (new Uint8Array(buf))[pos + i] = 0xab;
  return buf;
}

/** Minimal audio media: moof (traf: tfhd, tfdt, trun) + mdat with one sample. */
export function buildMinimalAudioMedia(): ArrayBuffer {
  const sampleSize = 200;
  const sampleDuration = 1024;
  const tfhdSize = 24;
  const tfdtSize = 16;
  const trunSize = 36; // 8 + 4+4+4+4 + 12 one sample
  const trafSize = 8 + tfhdSize + tfdtSize + trunSize;
  const moofSize = 8 + trafSize;
  const dataOffset = moofSize + 8;
  const mdatSize = 8 + sampleSize;
  const total = moofSize + mdatSize;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let pos = 0;

  setU32(dv, pos, moofSize);
  pos += 4;
  setType(dv, pos, MOOF);
  pos += 4;
  setU32(dv, pos, trafSize);
  pos += 4;
  setType(dv, pos, TRAF);
  pos += 4;
  setU32(dv, pos, tfhdSize);
  pos += 4;
  setType(dv, pos, TFHD);
  pos += 4;
  dv.setUint8(pos + 3, 0x18); // default_duration | default_size
  pos += 4;
  setU32(dv, pos, 1);
  pos += 4;
  setU32(dv, pos, sampleDuration);
  pos += 4;
  setU32(dv, pos, sampleSize);
  pos += 4;
  setU32(dv, pos, tfdtSize);
  pos += 4;
  setType(dv, pos, TFDT);
  pos += 4;
  dv.setUint8(pos, 0);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, trunSize);
  pos += 4;
  setType(dv, pos, TRUN);
  pos += 4;
  dv.setUint8(pos, 0);
  dv.setUint8(pos + 1, 0);
  dv.setUint8(pos + 2, 0x07);
  dv.setUint8(pos + 3, 0x05);
  pos += 4;
  setU32(dv, pos, 1);
  pos += 4;
  setU32(dv, pos, dataOffset);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, sampleDuration);
  pos += 4;
  setU32(dv, pos, sampleSize);
  pos += 4;
  setU32(dv, pos, 0);
  pos += 4;
  setU32(dv, pos, mdatSize);
  pos += 4;
  setType(dv, pos, MDAT);
  pos += 4;
  for (let i = 0; i < sampleSize; i++) (new Uint8Array(buf))[pos + i] = 0xcd;
  return buf;
}
