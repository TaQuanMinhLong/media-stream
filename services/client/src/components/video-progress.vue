<script setup lang="ts">
const props = defineProps<{
  bufferedEnd: number;
  currentTime: number;
  duration: number;
}>();
const emit = defineEmits<{ seek: [time: number] }>();
</script>

<template>
  <div class="relative w-full h-1.5 mb-2 cursor-pointer group/progress">
    <div class="absolute inset-0 bg-white/20 rounded-lg"></div>
    <div
      class="absolute top-0 left-0 h-full bg-white/40 rounded-lg transition-all duration-300 ease-linear"
      :style="{ width: (bufferedEnd / duration) * 100 + '%' }"
    ></div>
    <div
      class="absolute top-0 left-0 h-full bg-white rounded-lg pointer-events-none"
      :style="{ width: (currentTime / duration) * 100 + '%' }"
    ></div>
    <input
      type="range"
      min="0"
      :max="duration"
      step="0.1"
      :value="currentTime"
      @input="(e) => emit('seek', Number.parseFloat((e.target as HTMLInputElement).value))"
      class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
    />
  </div>
</template>
