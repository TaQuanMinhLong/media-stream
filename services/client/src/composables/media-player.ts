import type { MaybeComputedElementRef } from "@vueuse/core";
import type { MediaAssetMetadata } from "../types/media-metadata";
import init, { MediaClient } from "@media-stream/client";
import wasmUrl from "@media-stream/client/media_client_bg.wasm?url";
import { onMounted, ref, shallowRef, toValue } from "vue";
import MediaWorkerURL from "../media-worker?worker&url";
import { formatSegmentUrl, timeToSegmentIndex } from "../utils/seek-index";

const DEFAULT_DECRYPT = (buf: ArrayBuffer): Promise<ArrayBuffer> => Promise.resolve(buf);

let mediaClient: MediaClient | null = null;
async function getMediaClient(): Promise<MediaClient> {
  if (mediaClient) return mediaClient;
  await init({ module_or_path: wasmUrl });
  mediaClient = new MediaClient();
  return mediaClient;
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

  const clientRef = shallowRef<MediaClient | null>(null);
  const playerReady = ref(false);
  const currentTime = ref(0);
  const isPlaying = ref(false);
  const isBuffering = ref(false);
  const bufferedEnd = ref(0);
  const audioBufferedEnd = ref(0);
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
    const client = clientRef.value;
    if (!client || !playerReady.value) {
      if (tickScheduled) requestAnimationFrame(tick);
      return;
    }
    client.tick();
    try {
      if (hasInitialized.value && !isSeeking.value && metadata.value) {
        const { video: vMeta, audio: aMeta } = metadata.value;
        const time = currentTime.value;
        const vBuf = bufferedEnd.value ?? 0;
        const aBuf = audioBufferedEnd.value ?? 0;
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

  onMounted(async () => {
    try {
      const client = await getMediaClient();
      client.setOnStateUpdate(
        (data: {
          currentTime: number;
          isPlaying: boolean;
          bufferedEnd: number;
          audioBufferedEnd: number;
          isBuffering: boolean;
        }) => {
          currentTime.value = data.currentTime;
          isPlaying.value = data.isPlaying;
          bufferedEnd.value = data.bufferedEnd;
          audioBufferedEnd.value = data.audioBufferedEnd ?? 0;
          isBuffering.value = data.isBuffering;
        },
      );
      client.setOnReady(() => {
        playerReady.value = true;
      });
      client.setOnError((message: string) => {
        console.error("Media worker error:", message);
      });
      client.initWorker(MediaWorkerURL);

      const canvas = toValue(canvasRef);
      if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
        return console.error("Canvas not found");
      }
      const offscreen = await Promise.try(() => canvas.transferControlToOffscreen()).catch(
        (err) => {
          console.error("transferControlToOffscreen failed:", err);
          return null;
        },
      );
      if (!offscreen) return console.error("Failed to transfer control to offscreen");
      client.initCanvas(offscreen);
      clientRef.value = client;
    } catch (e) {
      console.error("Media client init failed:", e);
    }
  });

  function initVideo(initBuffer: ArrayBuffer) {
    const client = clientRef.value;
    if (!client) return console.error("Client not found");
    try {
      client.initVideo(initBuffer);
    } catch (e) {
      console.warn("initVideo failed:", e);
    }
  }

  function initAudio(initBuffer: ArrayBuffer): void {
    const client = clientRef.value;
    if (!client) return;
    try {
      client.initAudio(initBuffer);
    } catch (e) {
      console.warn("initAudio failed:", e);
    }
  }

  function feedVideoSegment(buffer: ArrayBuffer) {
    const client = clientRef.value;
    if (!client) return console.error("Client not found");
    try {
      client.feedVideoSegment(buffer);
    } catch (e) {
      console.warn("feedVideoSegment failed:", e);
    }
  }

  function feedAudioSegment(buffer: ArrayBuffer): void {
    const client = clientRef.value;
    if (!client) return;
    try {
      client.feedAudioSegment(buffer);
    } catch (e) {
      console.warn("feedAudioSegment failed:", e);
    }
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
      initAudio(decryptedAudioInit);
      hasInitialized.value = true;
    } catch (e) {
      console.error("Init failed", e);
    }
  }

  function seek(time: number): boolean {
    const client = clientRef.value;
    if (!client) return false;
    const wasPlaying = isPlaying.value;
    client.pause();
    client.seek(time);
    currentTime.value = time;
    return wasPlaying;
  }

  function resumeAfterSeek(): void {
    const client = clientRef.value;
    if (!client) return;
    client.play();
    isPlaying.value = true;
  }

  async function handleSeek(time: number): Promise<void> {
    const meta = metadata.value;
    if (!meta) return;
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
        (audioBufferedEnd.value ?? 0) < time + 0.5 && audioSegIdx.value <= aCount;
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
    if (!playerReady.value || !clientRef.value) return;
    if (videoSegIdx.value === 1) {
      await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);
    }
    if (isPlaying.value) {
      clientRef.value.pause();
    } else {
      clientRef.value.play();
    }
    isPlaying.value = !isPlaying.value;
  }

  function setVolume(volume: number): void {
    clientRef.value?.setVolume(volume);
  }

  function setMuted(muted: boolean): void {
    clientRef.value?.setMuted(muted);
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
    const client = clientRef.value;
    if (client) {
      client.terminate();
      clientRef.value = null;
    }
    playerReady.value = false;
  }

  return {
    workerRef: clientRef,
    playerReady,
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
