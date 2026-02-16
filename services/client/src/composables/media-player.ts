import type { MaybeComputedElementRef } from "@vueuse/core";
import type { MediaAssetMetadata } from "../types/media-metadata";
import { ref, shallowRef, toValue, watch } from "vue";
import MediaWorkerURL from "../media-worker?worker&url";
import { AudioPlayer } from "../models/audio-player";
import { formatSegmentUrl, timeToSegmentIndex } from "../utils/seek-index";

const DEFAULT_DECRYPT = (buf: ArrayBuffer): Promise<ArrayBuffer> => Promise.resolve(buf);

type WorkerStateUpdate = {
  type: "STATE_UPDATE";
  currentTime: number;
  isPlaying: boolean;
  bufferedEnd: number;
  isBuffering: boolean;
};
type WorkerReady = { type: "READY" };
type WorkerError = { type: "ERROR"; message: string };

function isStateUpdate(d: WorkerStateUpdate | WorkerReady | WorkerError): d is WorkerStateUpdate {
  return d.type === "STATE_UPDATE";
}

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

  const workerRef = shallowRef<Worker | null>(null);
  const playerReady = ref(false);
  const audioPlayer = shallowRef<AudioPlayer | null>(null);
  const currentTime = ref(0);
  const isPlaying = ref(false);
  const isBuffering = ref(false);
  const bufferedEnd = ref(0);
  const duration = ref(0);
  const metadata = shallowRef<MediaAssetMetadata | null>(null);

  // UI: controls visibility
  const showControls = ref(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  function resetHideTimer() {
    showControls.value = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (isPlaying.value) showControls.value = false;
    }, 3000);
  }

  let fetchAbortController = new AbortController();
  const videoSegIdx = ref(1);
  const audioSegIdx = ref(1);
  const isFetchingVideo = ref(false);
  const isFetchingAudio = ref(false);
  const hasInitialized = ref(false);
  const isSeeking = ref(false);

  let tickScheduled = false;

  function tick(): void {
    const worker = workerRef.value;
    if (!worker || !playerReady.value) {
      if (tickScheduled) requestAnimationFrame(tick);
      return;
    }
    // Drive the worker's render loop from the main thread's rAF for vsync alignment
    worker.postMessage({ type: "TICK" });
    try {
      // Pre-buffering: refs are updated by worker STATE_UPDATE
      if (hasInitialized.value && !isSeeking.value && metadata.value) {
        const { video: vMeta, audio: aMeta } = metadata.value;
        const time = currentTime.value;
        const vBuf = bufferedEnd.value ?? 0;
        const aBuf = audioPlayer.value?.bufferedEndSec ?? 0;
        if (vBuf - time < 10 && !isFetchingVideo.value && videoSegIdx.value <= vMeta.segmentCount) {
          fetchVideoSegment();
        }
        if (aBuf - time < 10 && !isFetchingAudio.value && audioSegIdx.value <= aMeta.segmentCount) {
          fetchAudioSegment();
        }
      }
    } catch (e) {
      console.warn("Pre-buffer tick error:", e);
    }
    if (tickScheduled) requestAnimationFrame(tick);
  }

  function startClockWhenReady(): void {
    if (tickScheduled) return;
    tickScheduled = true;
    requestAnimationFrame(tick);
  }

  watch(
    () => toValue(canvasRef),
    (canvas) => {
      if (!canvas || !(canvas instanceof HTMLCanvasElement) || workerRef.value) return;
      let offscreen: OffscreenCanvas;
      try {
        offscreen = canvas.transferControlToOffscreen();
      } catch (e) {
        console.error("transferControlToOffscreen failed:", e);
        return;
      }
      const worker = new Worker(MediaWorkerURL, { type: "module" });
      workerRef.value = worker;

      worker.onmessage = (event: MessageEvent<WorkerStateUpdate | WorkerReady | WorkerError>) => {
        const data = event.data;
        if (data.type === "READY") {
          playerReady.value = true;
          const ap = new AudioPlayer(() => currentTime.value);
          audioPlayer.value = ap;
          return;
        }
        if (data.type === "ERROR") {
          console.error("Media worker error:", data.message);
          return;
        }
        if (isStateUpdate(data)) {
          currentTime.value = data.currentTime;
          isPlaying.value = data.isPlaying;
          bufferedEnd.value = data.bufferedEnd;
          isBuffering.value = data.isBuffering;
        }
      };

      worker.onerror = (e) => {
        console.error("Media worker error", e);
      };

      worker.postMessage({ type: "INIT_CANVAS", canvas: offscreen }, [offscreen]);
    },
    { flush: "post" },
  );

  function initVideo(initBuffer: ArrayBuffer): void {
    const worker = workerRef.value;
    if (!worker) return;
    worker.postMessage({ type: "INIT_VIDEO", buffer: initBuffer }, [initBuffer]);
  }

  function initAudio(initBuffer: ArrayBuffer): void {
    audioPlayer.value?.setConfiguration(initBuffer);
  }

  function feedVideoSegment(buffer: ArrayBuffer): void {
    const worker = workerRef.value;
    if (!worker) return;
    worker.postMessage({ type: "FEED_VIDEO_SEGMENT", buffer }, [buffer]);
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
    if (!playerReady.value) {
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
    const worker = workerRef.value;
    const ap = audioPlayer.value;
    if (!worker) return false;
    const wasPlaying = isPlaying.value;
    worker.postMessage({ type: "PAUSE" });
    worker.postMessage({ type: "SEEK", time });
    ap?.seek(time);
    currentTime.value = time;
    return wasPlaying;
  }

  function resumeAfterSeek(): void {
    const worker = workerRef.value;
    const ap = audioPlayer.value;
    if (!worker) return;
    worker.postMessage({ type: "PLAY" });
    ap?.play();
    isPlaying.value = true;
  }

  async function handleSeek(time: number): Promise<void> {
    const meta = metadata.value;
    if (!meta) return;
    // Don't set isBuffering here — the canvas retains the last rendered frame
    // (displayFrame is kept alive during seek), so no spinner is needed.
    // If real buffering occurs, the worker's STATE_UPDATE will set it naturally.
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

      const needMoreVideo = bufferedEnd.value < time + 0.5 && videoSegIdx.value <= vCount;
      const needMoreAudio =
        (audioPlayer.value?.bufferedEndSec ?? 0) < time + 0.5 && audioSegIdx.value <= aCount;
      if (needMoreVideo || needMoreAudio) {
        await Promise.all([
          needMoreVideo ? fetchVideoSegment() : Promise.resolve(),
          needMoreAudio ? fetchAudioSegment() : Promise.resolve(),
        ]);
      }
      if (wasPlaying) resumeAfterSeek();
    } finally {
      isSeeking.value = false;
    }
  }

  async function togglePlay(): Promise<void> {
    await initMetadata();
    if (!playerReady.value || !workerRef.value) return;
    if (videoSegIdx.value === 1) {
      await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);
    }
    if (isPlaying.value) {
      workerRef.value.postMessage({ type: "PAUSE" });
      audioPlayer.value?.pause();
    } else {
      workerRef.value.postMessage({ type: "PLAY" });
      audioPlayer.value?.play();
    }
    // STATE_UPDATE from worker will sync isPlaying; optimistic update for UI
    isPlaying.value = !isPlaying.value;
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

  function terminateWorker(): void {
    const worker = workerRef.value;
    if (worker) {
      worker.terminate();
      workerRef.value = null;
    }
    playerReady.value = false;
    audioPlayer.value = null;
  }

  return {
    workerRef,
    playerReady,
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
    terminateWorker,
  };
}
