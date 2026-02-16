<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import { useMediaPlayer } from "../composables/media-player";
import { decrypt } from "../crypto/decrypt";
import VideoControllerRoot from "./video-controller-root.vue";
import VideoFullscreenToggle from "./video-fullscreen-toggle.vue";
import VideoPlayToggle from "./video-play-toggle.vue";
import VideoPlaybackTime from "./video-playback-time.vue";
import VideoProgress from "./video-progress.vue";
import VideoSpinner from "./video-spinner.vue";
import VideoVolumeSlider from "./video-volume-slider.vue";

const props = withDefaults(
  defineProps<{
    assetId: string;
    metadataUrl?: string;
  }>(),
  {},
);

const canvasRef = useTemplateRef("canvasRef");
const containerRef = useTemplateRef("containerRef");

const {
  currentTime,
  isPlaying,
  isBuffering,
  bufferedEnd,
  duration,
  showControls,
  resetHideTimer,
  loadMetadata,
  togglePlay,
  handleSeek,
  setVolume,
  setMuted,
  toggleFullscreen,
  startClockWhenReady,
  abortFetch,
} = useMediaPlayer(canvasRef, containerRef, {
  assetId: props.assetId,
  metadataUrl: props.metadataUrl,
  decrypt,
});

onMounted(() => {
  loadMetadata();
  startClockWhenReady();
});

onBeforeUnmount(() => {
  abortFetch();
});
</script>

<template>
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
            <VideoVolumeSlider @update:volume="setVolume" @update:isMuted="setMuted" />
          </div>
          <VideoPlaybackTime :current-time="currentTime" :duration="duration" />
        </div>
        <VideoFullscreenToggle @click="toggleFullscreen" />
      </div>
    </VideoControllerRoot>
  </div>
</template>

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
