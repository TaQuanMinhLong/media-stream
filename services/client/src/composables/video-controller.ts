import { ref } from "vue";

export function useVideoController() {
  const showControls = ref(true);
  const isPlaying = ref(false);
  const isBuffering = ref(true);
  let hideTimer: any;

  function resetHideTimer() {
    showControls.value = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (isPlaying.value) showControls.value = false;
    }, 3000);
  }

  return {
    isBuffering,
    showControls,
    isPlaying,
    resetHideTimer,
  };
}
