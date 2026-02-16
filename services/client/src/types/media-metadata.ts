/**
 * Metadata schema for a media asset. Fetched as /media/:asset/metadata.json.
 */

export interface MediaAssetMetadata {
  /** Total duration in seconds. */
  durationSec: number;
  video: {
    /** Init segment filename (e.g. "init-0.mp4"). */
    initUrl: string;
    /** Segment URL template; %05d is 1-based index (e.g. "chunk-0-%05d.m4s"). */
    segmentTemplate: string;
    segmentCount: number;
    /** Exact duration per segment in seconds for accurate seek; optional. */
    segmentDurationsSec?: number[];
    timescale?: number;
  };
  audio: {
    initUrl: string;
    segmentTemplate: string;
    segmentCount: number;
    segmentDurationsSec?: number[];
    timescale?: number;
  };
}
