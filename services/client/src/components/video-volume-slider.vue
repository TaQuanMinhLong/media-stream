<script setup lang="ts">
import { Volume1, Volume2, VolumeX } from "lucide-vue-next";

const isMuted = defineModel<boolean>("isMuted", { default: false });
const volume = defineModel<number>("volume", { default: 1 });
const prevVolume = defineModel<number>("prevVolume", { default: 1 });

const emit = defineEmits<{
  (e: "update:isMuted", value: boolean): void;
  (e: "update:volume", value: number): void;
}>();

function toggleMute() {
  isMuted.value = !isMuted.value;
  emit("update:isMuted", isMuted.value);
  if (!isMuted.value && volume.value === 0) {
    volume.value = prevVolume.value || 0.5;
    emit("update:volume", volume.value);
  }
}

function handleVolumeChange(e: Event) {
  const val = Number.parseFloat((e.target as HTMLInputElement).value);
  volume.value = val;
  emit("update:volume", val);
  if (val > 0) {
    isMuted.value = false;
    emit("update:isMuted", false);
    prevVolume.value = val;
  } else {
    isMuted.value = true;
    emit("update:isMuted", true);
  }
}
</script>

<template>
  <div class="flex items-center group/volume gap-2">
    <button
      @click="toggleMute"
      class="group-hover/volume:bg-white/10 p-2 rounded-full transition-all active:scale-90 cursor-pointer"
    >
      <VolumeX v-if="isMuted || volume === 0" class="size-6" />
      <Volume1 v-else-if="volume < 0.5" class="size-6" />
      <Volume2 v-else class="size-6" />
    </button>
    <div
      class="w-0 overflow-hidden group-hover/volume:overflow-visible group-hover/volume:w-20 transition-all duration-300 ease-out flex items-center"
    >
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        :value="isMuted ? 0 : volume"
        @input="handleVolumeChange"
        class="volume-slider w-16 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white"
      />
    </div>
  </div>
</template>

<style scoped>
/* Track: 4px, thumb: 12px — use margin-top to center thumb on track */
.volume-slider {
  padding: 0;
}
.volume-slider::-webkit-slider-runnable-track {
  height: 4px;
}
.volume-slider::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4px; /* center 12px thumb on 4px track */
}
.volume-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: none;
  background: white;
  border-radius: 50%;
}
</style>
