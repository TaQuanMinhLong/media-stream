<script setup lang="ts">
const props = defineProps<{ showControls: boolean }>();
</script>

<template>
  <div
    class="absolute bottom-0 left-0 w-full p-2 bg-linear-to-t from-black/95 via-black/50 to-transparent transition-all duration-500 z-30"
    :class="[
      showControls ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none',
    ]"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
