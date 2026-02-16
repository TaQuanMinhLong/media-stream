import { describe, expect, test } from "bun:test";
import { buildMinimalAudioInit, buildMinimalAudioMedia } from "../../test/fixtures/minimal-fmp4";
import { parseAudioInit, parseAudioMedia } from "./fmp4-audio";

describe("parseAudioInit", () => {
  test("returns null for empty buffer", () => {
    expect(parseAudioInit(new ArrayBuffer(0))).toBeNull();
  });

  test("returns null when moov is missing", () => {
    expect(parseAudioInit(new ArrayBuffer(20))).toBeNull();
  });

  test("parses minimal audio init and returns timescale, sampleRate, channels, codec", () => {
    const initBuffer = buildMinimalAudioInit();
    const result = parseAudioInit(initBuffer);
    expect(result).not.toBeNull();
    expect(result!.timescale).toBe(44100);
    expect(result!.sampleRate).toBe(44100);
    expect(result!.numberOfChannels).toBe(2);
    expect(result!.codec).toBe("mp4a.40.2");
  });
});

describe("parseAudioMedia", () => {
  test("returns null for empty buffer", () => {
    expect(parseAudioMedia(new ArrayBuffer(0))).toBeNull();
  });

  test("parses minimal audio media and returns samples", () => {
    const segmentBuffer = buildMinimalAudioMedia();
    const result = parseAudioMedia(segmentBuffer, 44100);
    expect(result).not.toBeNull();
    expect(result!.samples.length).toBeGreaterThan(0);
    const first = result!.samples[0]!;
    expect(first.timestampUs).toBeDefined();
    expect(typeof first.timestampUs).toBe("number");
    expect(first.durationUs).toBeDefined();
    expect(typeof first.durationUs).toBe("number");
    expect(first.data).toBeInstanceOf(Uint8Array);
    expect(first.data.length).toBeGreaterThan(0);
  });
});
