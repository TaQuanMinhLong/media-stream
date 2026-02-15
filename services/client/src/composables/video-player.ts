import type { MaybeComputedElementRef } from "@vueuse/core";
import { ref, shallowRef } from "vue";
import { AudioPlayer } from "../models/audio-player";
import { VideoPlayer } from "../models/video-player";
import shaderCode from "../shaders/video.wgsl?raw";
import { useWebGPU } from "./webgpu";

export function useVideoPlayer(
  canvasRef: MaybeComputedElementRef<HTMLCanvasElement | null | undefined>,
  options?: { onTick?: () => void },
) {
  const videoPlayer = shallowRef<VideoPlayer | null>(null);
  const audioPlayer = shallowRef<AudioPlayer | null>(null);
  const currentTime = ref(0);
  const isPlaying = ref(false);
  const isBuffering = ref(false);
  const bufferedEnd = ref(0);
  const duration = ref(246);

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
      options?.onTick?.();
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

  function togglePlay(): void {
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

  /**
   * Seek to a new time. Pauses the clock so it doesn't drift during fetch.
   * Returns whether the player was playing before seek (caller should resume if true).
   */
  function seek(time: number): boolean {
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    if (!vp) return false;
    const wasPlaying = vp.state === "playing";
    // Pause video clock so it doesn't advance during the fetch window
    if (wasPlaying) {
      vp.pause();
    }
    // Both seek methods are synchronous (close + recreate decoders)
    vp.seek(time);
    ap?.seek(time);
    currentTime.value = time;
    return wasPlaying;
  }

  /** Resume playback after seek + fetch. Resets the wall-clock origin to now. */
  function resumeAfterSeek(): void {
    const vp = videoPlayer.value;
    const ap = audioPlayer.value;
    if (!vp) return;
    vp.play();
    ap?.play();
    isPlaying.value = true;
  }

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

  return {
    gpu,
    videoPlayer,
    audioPlayer,
    currentTime,
    isPlaying,
    isBuffering,
    bufferedEnd,
    duration,
    togglePlay,
    seek,
    resumeAfterSeek,
    initVideo,
    initAudio,
    feedVideoSegment,
    feedAudioSegment,
    startClockWhenReady,
  };
}
