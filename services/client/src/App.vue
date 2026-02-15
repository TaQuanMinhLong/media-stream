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
import { useWebGPU } from "./composables/webgpu";
import shaderCode from "./shaders/video.wgsl?raw";

const canvasRef = useTemplateRef("canvasRef");
const containerRef = useTemplateRef("containerRef");

let fetchAbortController = new AbortController();

const video = document.createElement("video");
const mediaSource = new MediaSource();
let videoSourceBuffer: SourceBuffer | null = null;
let audioSourceBuffer: SourceBuffer | null = null;

video.src = URL.createObjectURL(mediaSource);
video.crossOrigin = "anonymous";
video.preload = "auto";

const currentTime = ref(0);
const duration = ref(246);
const bufferedEnd = ref(0);

// --- DASH Chunk Logic ---
const SEGMENT_DURATION = 4;
const videoTotalSegments = 44;
const audioTotalSegments = 62;
const segmentIndex = ref(1);
const isFetching = ref(false);
const hasInitialized = ref(false);

// --- UI Logic ---
const { showControls, isPlaying, isBuffering, resetHideTimer } = useVideoController();
const { gpuDevice, gpuContext, gpuPipeline, gpuSampler } = useWebGPU(canvasRef, shaderCode);

function drawFrame(frame: VideoFrame) {
  if (!gpuDevice.value || !gpuContext.value || !gpuPipeline.value || !gpuSampler.value) {
    frame.close();
    return;
  }
  const device = gpuDevice.value;
  const externalTexture = device.importExternalTexture({ source: frame });
  const bindGroup = device.createBindGroup({
    layout: gpuPipeline.value.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: externalTexture },
      { binding: 1, resource: gpuSampler.value },
    ],
  });

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: gpuContext.value.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: [0, 0, 0, 1],
      },
    ],
  });
  passEncoder.setPipeline(gpuPipeline.value);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.draw(4);
  passEncoder.end();
  device.queue.submit([commandEncoder.finish()]);
  frame.close();
}

function renderSingleFrame() {
  if (video.readyState >= 2) {
    try {
      const frame = new VideoFrame(video);
      drawFrame(frame);
    } catch (e) {}
  }
}

async function safeAppend(sb: SourceBuffer, data: ArrayBuffer) {
  return new Promise<void>((resolve, reject) => {
    function executeAppend() {
      function onUpdateEnd() {
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error("Append error"));
      }
      function cleanup() {
        sb.removeEventListener("updateend", onUpdateEnd);
        sb.removeEventListener("error", onError);
        sb.removeEventListener("abort", onError);
      }
      sb.addEventListener("updateend", onUpdateEnd);
      sb.addEventListener("error", onError);
      sb.addEventListener("abort", onError);
      try {
        sb.appendBuffer(data);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }

    if (sb.updating) {
      function waitClear() {
        sb.removeEventListener("updateend", waitClear);
        sb.removeEventListener("abort", waitClear);
        sb.removeEventListener("error", waitClear);
        executeAppend();
      }
      sb.addEventListener("updateend", waitClear);
      sb.addEventListener("abort", waitClear);
      sb.addEventListener("error", waitClear);
    } else {
      executeAppend();
    }
  });
}

async function fetchSegments() {
  const maxIdx = Math.max(videoTotalSegments, audioTotalSegments);
  if (isFetching.value || segmentIndex.value > maxIdx || !videoSourceBuffer || !audioSourceBuffer)
    return;

  isFetching.value = true;
  const idx = segmentIndex.value;
  const idxStr = String(idx).padStart(5, "0");
  const currentAbort = fetchAbortController;

  try {
    const fetchTasks = [];
    if (idx <= videoTotalSegments) {
      fetchTasks.push(
        fetch(`/media/sample/chunk-0-${idxStr}.m4s`, { signal: currentAbort.signal }).then(
          async (res) => {
            if (!res.ok) throw new Error(`Video chunk failed`);
            return safeAppend(videoSourceBuffer!, await res.arrayBuffer());
          },
        ),
      );
    }
    if (idx <= audioTotalSegments) {
      fetchTasks.push(
        fetch(`/media/sample/chunk-1-${idxStr}.m4s`, { signal: currentAbort.signal }).then(
          async (res) => {
            if (!res.ok) throw new Error(`Audio chunk failed`);
            return safeAppend(audioSourceBuffer!, await res.arrayBuffer());
          },
        ),
      );
    }
    await Promise.all(fetchTasks);
    if (currentAbort.signal.aborted) return;
    if (!isPlaying.value || video.readyState < 2) renderSingleFrame();
    if (segmentIndex.value === idx) segmentIndex.value++;
  } catch (e: any) {
    if (e.name === "AbortError" || currentAbort.signal.aborted) return;
    console.warn(`Segment ${idx} fetch error:`, e);
    if (segmentIndex.value === idx) segmentIndex.value++;
  } finally {
    if (!currentAbort.signal.aborted) isFetching.value = false;
  }
}

function processFrame() {
  if (video.ended && isPlaying.value) isPlaying.value = false;
  currentTime.value = video.currentTime;
  const buffered = video.buffered;
  let remaining = 0;
  let hasCurrentBuffer = false;
  let nearestFutureStart = -1;
  let currentBlockEnd = 0;

  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (video.currentTime >= start && video.currentTime <= end) {
      remaining = end - video.currentTime;
      hasCurrentBuffer = true;
      currentBlockEnd = end;
    }
    if (start > video.currentTime) {
      if (nearestFutureStart === -1 || start < nearestFutureStart) nearestFutureStart = start;
    }
  }

  bufferedEnd.value = hasCurrentBuffer ? currentBlockEnd : video.currentTime;

  if (!hasCurrentBuffer && nearestFutureStart !== -1) {
    if (nearestFutureStart - video.currentTime <= SEGMENT_DURATION) {
      video.currentTime = nearestFutureStart + 0.001;
      hasCurrentBuffer = true;
    }
  }

  if (
    remaining < 10 &&
    !isFetching.value &&
    segmentIndex.value <= Math.max(videoTotalSegments, audioTotalSegments)
  ) {
    fetchSegments();
  }

  isBuffering.value = isPlaying.value
    ? video.readyState < 3 || !hasCurrentBuffer
    : video.readyState < 2;

  if (isPlaying.value && video.readyState >= 2) {
    try {
      const frame = new VideoFrame(video);
      drawFrame(frame);
    } catch (e) {}
  }
  requestAnimationFrame(processFrame);
}

async function initMetadata() {
  if (hasInitialized.value || !videoSourceBuffer) return;
  try {
    const [vRes, aRes] = await Promise.all([
      fetch("/media/sample/init-0.mp4"),
      fetch("/media/sample/init-1.mp4"),
    ]);
    const [vInit, aInit] = await Promise.all([vRes.arrayBuffer(), aRes.arrayBuffer()]);
    await Promise.all([
      safeAppend(videoSourceBuffer!, vInit),
      safeAppend(audioSourceBuffer!, aInit),
    ]);
    hasInitialized.value = true;
  } catch (e) {
    console.error("Init failed", e);
  }
}

async function handleSeek(time: number) {
  isBuffering.value = true;
  fetchAbortController.abort();
  fetchAbortController = new AbortController();
  if (videoSourceBuffer?.updating) videoSourceBuffer.abort();
  if (audioSourceBuffer?.updating) audioSourceBuffer.abort();
  const targetSegment = Math.max(1, Math.floor(time / SEGMENT_DURATION) + 1);
  segmentIndex.value = targetSegment;
  isFetching.value = false;
  await fetchSegments();
  video.currentTime = time;
  function onReady() {
    renderSingleFrame();
    isBuffering.value = false;
  }
  if (video.readyState >= 2) onReady();
  else video.addEventListener("loadeddata", onReady, { once: true });
}

onMounted(() => {
  mediaSource.addEventListener("sourceopen", () => {
    mediaSource.duration = 246;
    videoSourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
    audioSourceBuffer = mediaSource.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    initMetadata();
  });
  processFrame();
});

async function togglePlay() {
  if (!hasInitialized.value) await initMetadata();
  if (video.paused) {
    if (segmentIndex.value === 1) await fetchSegments();
    video.play().catch(() => {});
    isPlaying.value = true;
  } else {
    video.pause();
    isPlaying.value = false;
  }
}

async function toggleFullscreen() {
  if (!containerRef.value) return;
  !document.fullscreenElement ? containerRef.value.requestFullscreen() : document.exitFullscreen();
}

onBeforeUnmount(() => {
  video.pause();
  URL.revokeObjectURL(video.src);
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
              <VideoVolumeSlider
                @update:volume="video.volume = $event"
                @update:isMuted="video.muted = $event"
              />
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
