import { describe, expect, test } from "bun:test";
import { formatSegmentUrl, timeToSegmentIndex } from "./seek-index";

describe("timeToSegmentIndex", () => {
  test("time 0 returns 1", () => {
    expect(timeToSegmentIndex(0, 44, 246)).toBe(1);
  });

  test("time at end returns segmentCount", () => {
    expect(timeToSegmentIndex(246, 44, 246)).toBe(44);
    expect(timeToSegmentIndex(300, 44, 246)).toBe(44);
  });

  test("mid-point with average duration", () => {
    const idx = timeToSegmentIndex(123, 44, 246);
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThanOrEqual(44);
    expect(idx).toBe(23); // floor(123 / (246/44)) + 1 = 23
  });

  test("uses segmentDurationsSec when provided", () => {
    const durations = [5, 5, 10]; // 3 segments, total 20s
    expect(timeToSegmentIndex(0, 3, 20, durations)).toBe(1);
    expect(timeToSegmentIndex(4, 3, 20, durations)).toBe(1);
    expect(timeToSegmentIndex(5, 3, 20, durations)).toBe(2);
    expect(timeToSegmentIndex(9, 3, 20, durations)).toBe(2);
    expect(timeToSegmentIndex(15, 3, 20, durations)).toBe(3);
    expect(timeToSegmentIndex(20, 3, 20, durations)).toBe(3);
  });
});

describe("formatSegmentUrl", () => {
  test("formats %05d with 1-based index", () => {
    expect(formatSegmentUrl("chunk-0-%05d.m4s", 1)).toBe("chunk-0-00001.m4s");
    expect(formatSegmentUrl("chunk-0-%05d.m4s", 44)).toBe("chunk-0-00044.m4s");
  });

  test("formats %03d", () => {
    expect(formatSegmentUrl("chunk-%03d.m4s", 1)).toBe("chunk-001.m4s");
  });
});
