<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import VideoControllerRoot from "./components/video-controller-root.vue";
import VideoFullscreenToggle from "./components/video-fullscreen-toggle.vue";
import VideoPlayToggle from "./components/video-play-toggle.vue";
import VideoPlaybackTime from "./components/video-playback-time.vue";
import VideoProgress from "./components/video-progress.vue";
import VideoSpinner from "./components/video-spinner.vue";
import VideoVolumeSlider from "./components/video-volume-slider.vue";
import { useVideoController } from "./composables/video-controller";
import { useVideoPlayer } from "./composables/video-player";
import { decrypt } from "./crypto/decrypt";

const canvasRef = useTemplateRef("canvasRef");
const containerRef = useTemplateRef("containerRef");

let fetchAbortController = new AbortController();

const VIDEO_TOTAL = 44;
const AUDIO_TOTAL = 62;
const TOTAL_DURATION = 246;
const AVG_VIDEO_SEG = TOTAL_DURATION / VIDEO_TOTAL; // ~5.59s
const AVG_AUDIO_SEG = TOTAL_DURATION / AUDIO_TOTAL; // ~3.97s

const videoSegIdx = ref(1);
const audioSegIdx = ref(1);
const isFetchingVideo = ref(false);
const isFetchingAudio = ref(false);
const hasInitialized = ref(false);
/** True while handleSeek owns fetching — prevents the tick loop from racing. */
const isSeeking = ref(false);

const { showControls, isPlaying, isBuffering, resetHideTimer } = useVideoController();
const {
  currentTime,
  isPlaying: isPlayingState,
  isBuffering: isBufferingState,
  bufferedEnd,
  duration,
  togglePlay: togglePlayPlayer,
  seek,
  resumeAfterSeek,
  initVideo,
  initAudio,
  feedVideoSegment,
  feedAudioSegment,
  startClockWhenReady,
  videoPlayer,
  audioPlayer,
} = useVideoPlayer(canvasRef, {
  onTick: () => {
    isPlaying.value = isPlayingState.value;
    isBuffering.value = isBufferingState.value;
    if (!hasInitialized.value) return;
    // While handleSeek owns the fetch cycle, don't trigger competing fetches
    if (isSeeking.value) return;
    const time = currentTime.value;
    const vBuf = videoPlayer.value?.bufferedEndSec ?? 0;
    const aBuf = audioPlayer.value?.bufferedEndSec ?? 0;
    // Fetch video and audio independently based on their own buffer levels
    if (vBuf - time < 10 && !isFetchingVideo.value && videoSegIdx.value <= VIDEO_TOTAL) {
      fetchVideoSegment();
    }
    if (aBuf - time < 10 && !isFetchingAudio.value && audioSegIdx.value <= AUDIO_TOTAL) {
      fetchAudioSegment();
    }
  },
});

async function fetchVideoSegment() {
  if (isFetchingVideo.value || videoSegIdx.value > VIDEO_TOTAL) return;
  isFetchingVideo.value = true;
  const idx = videoSegIdx.value;
  const idxStr = String(idx).padStart(5, "0");
  const abort = fetchAbortController;
  try {
    const res = await fetch(`/media/sample/chunk-0-${idxStr}.m4s`, { signal: abort.signal });
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

async function fetchAudioSegment() {
  if (isFetchingAudio.value || audioSegIdx.value > AUDIO_TOTAL) return;
  isFetchingAudio.value = true;
  const idx = audioSegIdx.value;
  const idxStr = String(idx).padStart(5, "0");
  const abort = fetchAbortController;
  try {
    const res = await fetch(`/media/sample/chunk-1-${idxStr}.m4s`, { signal: abort.signal });
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

async function initMetadata() {
  if (hasInitialized.value) return;
  if (!videoPlayer.value) {
    console.warn("Player not ready yet (WebGPU initializing). Click play again in a moment.");
    return;
  }
  try {
    const [vRes, aRes] = await Promise.all([
      fetch("/media/sample/init-0.mp4"),
      fetch("/media/sample/init-1.mp4"),
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

async function handleSeek(time: number) {
  isBuffering.value = true;
  isSeeking.value = true; // Block tick-loop fetches so they don't race with us
  try {
    fetchAbortController.abort();
    fetchAbortController = new AbortController();
    // Compute correct segment index for each track independently
    videoSegIdx.value = Math.max(1, Math.min(VIDEO_TOTAL, Math.floor(time / AVG_VIDEO_SEG) + 1));
    audioSegIdx.value = Math.max(1, Math.min(AUDIO_TOTAL, Math.floor(time / AVG_AUDIO_SEG) + 1));
    isFetchingVideo.value = false;
    isFetchingAudio.value = false;
    // Seek pauses the clock so it doesn't drift during fetch
    const wasPlaying = seek(time);
    // Fetch first pair of segments
    await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);
    // If the first segments didn't cover the seek time (variable segment durations),
    // fetch another pair so the user doesn't see a freeze
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    const needMoreVideo = vp && vp.bufferedEndSec < time + 0.5 && videoSegIdx.value <= VIDEO_TOTAL;
    const needMoreAudio = ap && ap.bufferedEndSec < time + 0.5 && audioSegIdx.value <= AUDIO_TOTAL;
    if (needMoreVideo || needMoreAudio) {
      await Promise.all([
        needMoreVideo ? fetchVideoSegment() : Promise.resolve(),
        needMoreAudio ? fetchAudioSegment() : Promise.resolve(),
      ]);
    }
    // Resume from the seek position with a fresh clock origin
    if (wasPlaying) resumeAfterSeek();
  } finally {
    isSeeking.value = false; // Re-enable tick-loop fetches
    isBuffering.value = false;
  }
}

onMounted(() => {
  startClockWhenReady();
});

async function togglePlay() {
  if (!hasInitialized.value) await initMetadata();
  if (!videoPlayer.value) return;
  if (videoSegIdx.value === 1) {
    await Promise.all([fetchVideoSegment(), fetchAudioSegment()]);
  }
  togglePlayPlayer();
}

function onVolumeUpdate(volume: number) {
  audioPlayer.value?.setVolume(volume);
}

function onMutedUpdate(muted: boolean) {
  audioPlayer.value?.setMuted(muted);
}

async function toggleFullscreen() {
  if (!containerRef.value) return;
  !document.fullscreenElement ? containerRef.value.requestFullscreen() : document.exitFullscreen();
}

onBeforeUnmount(() => {
  fetchAbortController.abort();
});
</script>

<template>
  <main class="min-h-screen flex items-center justify-center bg-gray-900 p-4">
    <div
      ref="containerRef"
      class="relative bg-black overflow-hidden group rounded-lg shadow-2xl border border-white/5"
      @mousemove="resetHideTimer"
    >
      <VideoSpinner :is-loading="isBuffering" />

      <canvas
        ref="canvasRef"
        width="1920"
        height="1080"
        class="bg-black w-full h-auto max-w-5xl aspect-video cursor-pointer"
        @click="togglePlay"
        @dblclick="toggleFullscreen"
      />

      <VideoControllerRoot :show-controls="showControls || !isPlaying">
        <VideoProgress
          :buffered-end="bufferedEnd"
          :current-time="currentTime"
          :duration="duration"
          @seek="handleSeek"
        />

        <div class="flex items-center justify-between text-white px-1">
          <div class="flex items-center gap-2">
            <div class="flex items-center gap-2">
              <VideoPlayToggle v-model:is-playing="isPlaying" @toggle-play="togglePlay" />
              <VideoVolumeSlider @update:volume="onVolumeUpdate" @update:isMuted="onMutedUpdate" />
            </div>
            <VideoPlaybackTime :current-time="currentTime" :duration="duration" />
          </div>
          <VideoFullscreenToggle @click="toggleFullscreen" />
        </div>
      </VideoControllerRoot>
    </div>
  </main>
</template>

<style>
/* Standard Progress Thumb */
input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: white;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
  margin-top: -6px;
  position: relative;
  z-index: 20;
}

input[type="range"]::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: white;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}
</style>

<style scoped>
div:fullscreen {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: black;
  border: none;
  border-radius: 0;
}

div:fullscreen canvas {
  width: 100%;
  height: 100%;
  max-width: none;
  object-fit: contain;
}
</style>
