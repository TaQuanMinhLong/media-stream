import { describe, expect, test } from "bun:test";
import { buildMinimalAudioMedia, buildMinimalVideoInit } from "../../test/fixtures/minimal-fmp4";
import { parseVideoInit, parseVideoMedia } from "./fmp4-video";

describe("parseVideoInit", () => {
  test("returns null for empty buffer", () => {
    expect(parseVideoInit(new ArrayBuffer(0))).toBeNull();
  });

  test("returns null when moov is missing", () => {
    const buf = new ArrayBuffer(20);
    expect(parseVideoInit(buf)).toBeNull();
  });

  test("parses minimal video init and returns timescale, codec, description", () => {
    const initBuffer = buildMinimalVideoInit();
    const result = parseVideoInit(initBuffer);
    expect(result).not.toBeNull();
    expect(result!.timescale).toBe(12800);
    expect(result!.codec).toMatch(/^avc1\.[0-9A-F]{6}$/);
    expect(result!.codec).toBe("avc1.42E01E");
    expect(result!.description).toBeInstanceOf(Uint8Array);
    expect(result!.description.length).toBeGreaterThanOrEqual(4);
  });
});

describe("parseVideoMedia", () => {
  test("returns null for empty buffer", () => {
    expect(parseVideoMedia(new ArrayBuffer(0))).toBeNull();
  });

  test("parses minimal video media and returns samples", () => {
    // Use same segment structure as audio (moof+traf+trun+mdat); video parser accepts it
    const segmentBuffer = buildMinimalAudioMedia();
    const result = parseVideoMedia(segmentBuffer, 12800);
    expect(result).not.toBeNull();
    expect(result!.samples.length).toBeGreaterThan(0);
    const first = result!.samples[0]!;
    expect(first.timestampUs).toBeDefined();
    expect(typeof first.timestampUs).toBe("number");
    expect(first.durationUs).toBeDefined();
    expect(typeof first.durationUs).toBe("number");
    expect(first.isKey).toBe(true);
    expect(first.data).toBeInstanceOf(Uint8Array);
    expect(first.data.length).toBeGreaterThan(0);
  });
});
