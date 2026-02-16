import type { MaybeComputedElementRef } from "@vueuse/core";
import type { MediaAssetMetadata } from "../types/media-metadata";
import { ref, shallowRef, toValue } from "vue";
import { AudioPlayer } from "../models/audio-player";
import { VideoPlayer } from "../models/video-player";
import shaderCode from "../shaders/video.wgsl?raw";
import { formatSegmentUrl, timeToSegmentIndex } from "../utils/seek-index";
import { useWebGPU } from "./webgpu";

const DEFAULT_DECRYPT = (buf: ArrayBuffer): Promise<ArrayBuffer> => Promise.resolve(buf);

export function useMediaPlayer(
  canvasRef: MaybeComputedElementRef<HTMLCanvasElement | null | undefined>,
  containerRef: MaybeComputedElementRef<HTMLElement | null | undefined>,
  options: {
    assetId: string;
    metadataUrl?: string;
    decrypt?: (buf: ArrayBuffer) => Promise<ArrayBuffer>;
  },
) {
  const { assetId, decrypt = DEFAULT_DECRYPT } = options;
  const metadataUrl = options.metadataUrl ?? `/media/${assetId}/metadata.json`;

  const videoPlayer = shallowRef<VideoPlayer | null>(null);
  const audioPlayer = shallowRef<AudioPlayer | null>(null);
  const currentTime = ref(0);
  const isPlaying = ref(false);
  const isBuffering = ref(false);
  const bufferedEnd = ref(0);
  const duration = ref(0);
  const metadata = shallowRef<MediaAssetMetadata | null>(null);

  // UI: controls visibility (from useVideoController)
  const showControls = ref(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function resetHideTimer() {
    showControls.value = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (isPlaying.value) showControls.value = false;
    }, 3000);
  }

  // Internal: fetch state (not exposed to template)
  let fetchAbortController = new AbortController();
  const videoSegIdx = ref(1);
  const audioSegIdx = ref(1);
  const isFetchingVideo = ref(false);
  const isFetchingAudio = ref(false);
  const hasInitialized = ref(false);
  const isSeeking = ref(false);

  let tickScheduled = false;

  function tick(): void {
    const vp = videoPlayer.value;
    if (!vp) {
      if (tickScheduled) requestAnimationFrame(tick);
      return;
    }
    try {
      currentTime.value = vp.tick();
      bufferedEnd.value = vp.bufferedEndSec;
      isBuffering.value = vp.isBuffering;
      isPlaying.value = vp.state === "playing";

      // Pre-buffering
      if (hasInitialized.value && !isSeeking.value && metadata.value) {
        const { video: vMeta, audio: aMeta } = metadata.value;
        const time = currentTime.value;
        const vBuf = vp.bufferedEndSec ?? 0;
        const aBuf = audioPlayer.value?.bufferedEndSec ?? 0;
        if (vBuf - time < 10 && !isFetchingVideo.value && videoSegIdx.value <= vMeta.segmentCount) {
          fetchVideoSegment();
        }
        if (aBuf - time < 10 && !isFetchingAudio.value && audioSegIdx.value <= aMeta.segmentCount) {
          fetchAudioSegment();
        }
      }
    } catch (e) {
      console.warn("Video tick error:", e);
    }
    if (tickScheduled) requestAnimationFrame(tick);
  }

  function startClockWhenReady(): void {
    if (tickScheduled) return;
    tickScheduled = true;
    requestAnimationFrame(tick);
  }

  const gpu = useWebGPU(canvasRef, shaderCode, {
    onReady: (gpuDevice, gpuContext, gpuPipeline, gpuSampler) => {
      const vp = new VideoPlayer(gpuDevice, gpuContext, gpuPipeline, gpuSampler);
      const ap = new AudioPlayer(() => vp.currentTime);
      videoPlayer.value = vp;
      audioPlayer.value = ap;
      startClockWhenReady();
    },
  });

  function initVideo(initBuffer: ArrayBuffer): void {
    videoPlayer.value?.setConfiguration(initBuffer);
  }

  function initAudio(initBuffer: ArrayBuffer): void {
    audioPlayer.value?.setConfiguration(initBuffer);
  }

  function feedVideoSegment(buffer: ArrayBuffer): void {
    videoPlayer.value?.feedSegment(buffer);
  }

  function feedAudioSegment(buffer: ArrayBuffer): void {
    audioPlayer.value?.feedSegment(buffer);
  }

  async function fetchVideoSegment(): Promise<void> {
    const meta = metadata.value;
    if (!meta || isFetchingVideo.value || videoSegIdx.value > meta.video.segmentCount) return;
    isFetchingVideo.value = true;
    const idx = videoSegIdx.value;
    const url = `/media/${assetId}/${formatSegmentUrl(meta.video.segmentTemplate, idx)}`;
    const abort = fetchAbortController;
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error("Video chunk failed");
      const buf = await res.arrayBuffer();
      if (abort.signal.aborted) return;
      const decrypted = await decrypt(buf);
      if (!abort.signal.aborted) feedVideoSegment(decrypted);
      if (videoSegIdx.value === idx) videoSegIdx.value++;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      if (abort.signal.aborted) return;
      console.warn(`Video segment ${idx} fetch error:`, e);
      if (videoSegIdx.value === idx) videoSegIdx.value++;
    } finally {
      if (!abort.signal.aborted) isFetchingVideo.value = false;
    }
  }

  async function fetchAudioSegment(): Promise<void> {
    const meta = metadata.value;
    if (!meta || isFetchingAudio.value || audioSegIdx.value > meta.audio.segmentCount) return;
    isFetchingAudio.value = true;
    const idx = audioSegIdx.value;
    const url = `/media/${assetId}/${formatSegmentUrl(meta.audio.segmentTemplate, idx)}`;
    const abort = fetchAbortController;
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error("Audio chunk failed");
      const buf = await res.arrayBuffer();
      if (abort.signal.aborted) return;
      const decrypted = await decrypt(buf);
      if (!abort.signal.aborted) feedAudioSegment(decrypted);
      if (audioSegIdx.value === idx) audioSegIdx.value++;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") return;
      if (abort.signal.aborted) return;
      console.warn(`Audio segment ${idx} fetch error:`, e);
      if (audioSegIdx.value === idx) audioSegIdx.value++;
    } finally {
      if (!abort.signal.aborted) isFetchingAudio.value = false;
    }
  }

  async function loadMetadata(): Promise<MediaAssetMetadata | null> {
    if (metadata.value) return metadata.value;
    try {
      const res = await fetch(metadataUrl);
      if (!res.ok) return null;
      const data = (await res.json()) as MediaAssetMetadata;
      metadata.value = data;
      duration.value = data.durationSec;
      return data;
    } catch (e) {
      console.error("Failed to load metadata:", e);
      return null;
    }
  }

  async function initMetadata(): Promise<void> {
    if (hasInitialized.value) return;
    if (!videoPlayer.value) {
      console.warn("Player not ready yet (WebGPU initializing). Click play again in a moment.");
      return;
    }
    const meta = await loadMetadata();
    if (!meta) return;
    try {
      const [vRes, aRes] = await Promise.all([
        fetch(`/media/${assetId}/${meta.video.initUrl}`),
        fetch(`/media/${assetId}/${meta.audio.initUrl}`),
      ]);
      const [vInit, aInit] = await Promise.all([vRes.arrayBuffer(), aRes.arrayBuffer()]);
      const [decryptedVideoInit, decryptedAudioInit] = await Promise.all([
        decrypt(vInit),
        decrypt(aInit),
      ]);
      initVideo(decryptedVideoInit);
      hasInitialized.value = true;
      initAudio(decryptedAudioInit);
    } catch (e) {
      console.error("Init failed", e);
    }
  }

  function seek(time: number): boolean {
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    if (!vp) return false;
    const wasPlaying = vp.state === "playing";
    if (wasPlaying) vp.pause();
    vp.seek(time);
    ap?.seek(time);
    currentTime.value = time;
    return wasPlaying;
  }

  function resumeAfterSeek(): void {
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    if (!vp) return;
    vp.play();
    ap?.play();
    isPlaying.value = true;
  }

  async function handleSeek(time: number): Promise<void> {
    const meta = metadata.value;
    if (!meta) return;
    isBuffering.value = true;
    isSeeking.value = true;
    try {
      fetchAbortController.abort();
      fetchAbortController = new AbortController();

      const vCount = meta.video.segmentCount;
      const aCount = meta.audio.segmentCount;
      const dur = meta.durationSec;
      videoSegIdx.value = timeToSegmentIndex(time, vCount, dur, meta.video.segmentDurationsSec);
      audioSegIdx.value = timeToSegmentIndex(time, aCount, dur, meta.audio.segmentDurationsSec);
      isFetchingVideo.value = false;
      isFetchingAudio.value = false;

      const wasPlaying = seek(time);
      await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);

      const vp = videoPlayer.value;
      const ap = audioPlayer.value;
      const needMoreVideo = vp && vp.bufferedEndSec < time + 0.5 && videoSegIdx.value <= vCount;
      const needMoreAudio = ap && ap.bufferedEndSec < time + 0.5 && audioSegIdx.value <= aCount;
      if (needMoreVideo || needMoreAudio) {
        await Promise.all([
          needMoreVideo ? fetchVideoSegment() : Promise.resolve(),
          needMoreAudio ? fetchAudioSegment() : Promise.resolve(),
        ]);
      }
      if (wasPlaying) resumeAfterSeek();
    } finally {
      isSeeking.value = false;
      isBuffering.value = false;
    }
  }

  async function togglePlay(): Promise<void> {
    await initMetadata();
    if (!videoPlayer.value) return;
    if (videoSegIdx.value === 1) {
      await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);
    }
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    if (!vp) return;
    if (vp.state === "playing") {
      vp.pause();
      ap?.pause();
    } else {
      vp.play();
      ap?.play();
    }
    isPlaying.value = vp.state === "playing";
  }

  function setVolume(volume: number): void {
    audioPlayer.value?.setVolume(volume);
  }

  function setMuted(muted: boolean): void {
    audioPlayer.value?.setMuted(muted);
  }

  function toggleFullscreen(): void {
    const container = toValue(containerRef) as HTMLElement | null | undefined;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  function abortFetch(): void {
    fetchAbortController.abort();
  }

  return {
    gpu,
    videoPlayer,
    audioPlayer,
    currentTime,
    isPlaying,
    isBuffering,
    bufferedEnd,
    duration,
    showControls,
    resetHideTimer,
    metadata,
    loadMetadata,
    togglePlay,
    handleSeek,
    setVolume,
    setMuted,
    toggleFullscreen,
    startClockWhenReady,
    abortFetch,
  };
}
