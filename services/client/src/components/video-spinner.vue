<script setup lang="ts">
const props = defineProps<{ isLoading: boolean }>();
</script>

<template>
  <div
    v-if="isLoading"
    class="absolute inset-0 z-20 flex items-center justify-center bg-black/40 pointer-events-none transition-opacity duration-300"
  >
    <div class="w-12 h-12 border-4 border-white/10 border-t-white rounded-full animate-spin"></div>
  </div>
</template>
