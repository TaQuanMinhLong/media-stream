/**
 * Generates metadata.json from an entry folder containing init segments and chunk files.
 * Source of truth: the folder contents (and optional manifest.mpd for duration/timeline).
 *
 * Usage:
 *   bun run services/server/scripts/generate-metadata.ts <entry-folder>
 *   ENTRY_DIR=/path/to/sample bun run services/server/scripts/generate-metadata.ts
 *
 * Entry folder must contain:
 *   - init-0.mp4, init-1.mp4 (video, audio init)
 *   - chunk-0-00001.m4s, chunk-0-00002.m4s, ... (video segments)
 *   - chunk-1-00001.m4s, chunk-1-00002.m4s, ... (audio segments)
 * Optional: manifest.mpd — if present, duration and segment durations are read from it.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ENTRY_DIR = process.argv[2] ?? process.env.ENTRY_DIR;
if (!ENTRY_DIR) {
  console.error("Usage: bun run generate-metadata.ts <entry-folder>");
  console.error("   or: ENTRY_DIR=/path/to/asset bun run generate-metadata.ts");
  process.exit(1);
}

const entryPath = path.resolve(ENTRY_DIR);
const files = readdirSync(entryPath, { withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => d.name);

// Discover init files: init-0.mp4, init-1.mp4 (representation id = track)
const initPattern = /^init-(\d+)\.mp4$/i;
const inits = files
  .filter((f) => initPattern.test(f))
  .map((f) => {
    const m = f.match(initPattern)!;
    return { id: parseInt(m[1]!, 10), filename: f };
  })
  .sort((a, b) => a.id - b.id);

// Discover chunk files: chunk-<track>-<number>.m4s
const chunkPattern = /^chunk-(\d+)-(\d+)\.m4s$/i;
const chunksByTrack = new Map<number, { index: number; filename: string }[]>();
for (const f of files) {
  const m = f.match(chunkPattern);
  if (!m) continue;
  const trackId = parseInt(m[1]!, 10);
  const index = parseInt(m[2]!, 10);
  if (!chunksByTrack.has(trackId)) chunksByTrack.set(trackId, []);
  chunksByTrack.get(trackId)!.push({ index, filename: f });
}
for (const arr of chunksByTrack.values()) {
  arr.sort((a, b) => a.index - b.index);
}

// First track = video (0), second = audio (1)
const videoTrackId = inits[0]?.id ?? 0;
const audioTrackId = inits[1]?.id ?? 1;
const videoChunks = chunksByTrack.get(videoTrackId) ?? [];
const audioChunks = chunksByTrack.get(audioTrackId) ?? [];

function segmentTemplateFromChunks(
  trackId: number,
  chunks: { index: number; filename: string }[],
): string {
  if (chunks.length === 0) return `chunk-${trackId}-%05d.m4s`;
  const first = chunks[0]!.filename;
  const numPart = first.match(/-(\d+)\.m4s$/)?.[1] ?? "00001";
  const pad = numPart.length;
  const fmt = pad >= 5 ? "%05d" : `%0${pad}d`;
  return `chunk-${trackId}-${fmt}.m4s`;
}

// Parse manifest.mpd if present (duration + optional segment timelines)
let durationSec = 0;
let videoTimescale = 12800;
let audioTimescale = 44100;
let videoSegmentDurationsSec: number[] | undefined;
let audioSegmentDurationsSec: number[] | undefined;

const mpdPath = path.join(entryPath, "manifest.mpd");
try {
  const mpdContent = readFileSync(mpdPath, "utf-8");

  // mediaPresentationDuration="PT4M6.1S" -> seconds
  const durationMatch = mpdContent.match(
    /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/,
  );
  if (durationMatch) {
    const h = parseInt(durationMatch[1] ?? "0", 10);
    const m = parseInt(durationMatch[2] ?? "0", 10);
    const s = parseFloat(durationMatch[3] ?? "0");
    durationSec = h * 3600 + m * 60 + s;
  }

  // SegmentTemplate timescale="12800" (per Representation)
  const timescaleMatches = mpdContent.matchAll(/SegmentTemplate\s+[^>]*timescale="(\d+)"/g);
  const timescales = [...timescaleMatches].map((m) => parseInt(m[1]!, 10));
  if (timescales[0] != null) videoTimescale = timescales[0];
  if (timescales[1] != null) audioTimescale = timescales[1];

  // SegmentTimeline: <S t="0" d="64000" /> or <S d="177152" r="59" />
  function parseSegmentTimeline(xml: string, timescale: number): number[] {
    const durations: number[] = [];
    const sRegex = /<S\s+(?:t="[^"]*"\s+)?d="(\d+)"(?:\s+r="(\d+)")?/g;
    let m: RegExpExecArray | null;
    while ((m = sRegex.exec(xml)) !== null) {
      const d = parseInt(m[1]!, 10);
      const r = m[2] ? parseInt(m[2]!, 10) : 1;
      const sec = d / timescale;
      for (let i = 0; i < r; i++) durations.push(sec);
    }
    return durations;
  }

  // Two AdaptationSets: first video, second audio; each has one Representation with SegmentTimeline
  const segmentTimelines = mpdContent.matchAll(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/g);
  const timelines = [...segmentTimelines].map((m) => m[1]!);
  if (timelines[0]) {
    videoSegmentDurationsSec = parseSegmentTimeline(timelines[0], videoTimescale);
  }
  if (timelines[1]) {
    audioSegmentDurationsSec = parseSegmentTimeline(timelines[1], audioTimescale);
  }
} catch {
  // No manifest.mpd or unreadable: use segment count only, estimate duration from counts
  if (durationSec <= 0 && (videoChunks.length > 0 || audioChunks.length > 0)) {
    const avgVideo = videoChunks.length > 0 ? 5.5 : 0;
    const avgAudio = audioChunks.length > 0 ? 4 : 0;
    durationSec = Math.max(videoChunks.length * avgVideo, audioChunks.length * avgAudio);
    durationSec = Math.round(durationSec * 10) / 10;
  }
}

const videoInit = inits.find((i) => i.id === videoTrackId);
const audioInit = inits.find((i) => i.id === audioTrackId);

// Segment count: from folder (chunk files) or from MPD timeline when no chunks present
const videoSegmentCount =
  videoChunks.length > 0 ? videoChunks.length : (videoSegmentDurationsSec?.length ?? 0);
const audioSegmentCount =
  audioChunks.length > 0 ? audioChunks.length : (audioSegmentDurationsSec?.length ?? 0);

const metadata = {
  durationSec,
  video: {
    initUrl: videoInit?.filename ?? "init-0.mp4",
    segmentTemplate: segmentTemplateFromChunks(videoTrackId, videoChunks),
    segmentCount: videoSegmentCount,
    ...(videoSegmentDurationsSec && videoSegmentDurationsSec.length > 0
      ? { segmentDurationsSec: videoSegmentDurationsSec }
      : {}),
    timescale: videoTimescale,
  },
  audio: {
    initUrl: audioInit?.filename ?? "init-1.mp4",
    segmentTemplate: segmentTemplateFromChunks(audioTrackId, audioChunks),
    segmentCount: audioSegmentCount,
    ...(audioSegmentDurationsSec && audioSegmentDurationsSec.length > 0
      ? { segmentDurationsSec: audioSegmentDurationsSec }
      : {}),
    timescale: audioTimescale,
  },
};

const outPath = path.join(entryPath, "metadata.json");
writeFileSync(outPath, JSON.stringify(metadata, null, 2), "utf-8");
console.log("Wrote", outPath);
console.log(
  "  video:",
  metadata.video.segmentCount,
  "segments, audio:",
  metadata.audio.segmentCount,
  "segments, duration:",
  metadata.durationSec,
  "s",
);
