/**
 * Maps playback time (seconds) to 1-based segment index for pre-buffering and seek.
 * Uses exact segment durations when available, otherwise average duration.
 */

/**
 * Returns the 1-based segment index for the given time.
 * @param timeSec - Current time in seconds
 * @param segmentCount - Total number of segments
 * @param durationSec - Total duration in seconds (used when segmentDurationsSec is not provided)
 * @param segmentDurationsSec - Optional exact duration per segment in seconds
 */
export function timeToSegmentIndex(
  timeSec: number,
  segmentCount: number,
  durationSec: number,
  segmentDurationsSec?: number[],
): number {
  if (segmentCount <= 0) return 1;
  if (timeSec <= 0) return 1;
  if (timeSec >= durationSec) return segmentCount;

  if (segmentDurationsSec && segmentDurationsSec.length > 0) {
    let acc = 0;
    for (let i = 0; i < segmentDurationsSec.length; i++) {
      acc += segmentDurationsSec[i]!;
      if (timeSec < acc) return i + 1;
    }
    return segmentCount;
  }

  const avgSegSec = durationSec / segmentCount;
  const index = Math.floor(timeSec / avgSegSec) + 1;
  return Math.max(1, Math.min(segmentCount, index));
}

/**
 * Formats segment template with 1-based index (e.g. "chunk-0-%05d.m4s" -> "chunk-0-00001.m4s").
 */
export function formatSegmentUrl(template: string, index: number): string {
  return template.replace(/%0?(\d*)d/, (_, w) =>
    String(index).padStart(w ? parseInt(w, 10) : 5, "0"),
  );
}
