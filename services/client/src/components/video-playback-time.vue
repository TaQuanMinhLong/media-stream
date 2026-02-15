<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ currentTime: number; duration: number }>();
const currentTimeString = computed(() => {
  return `${Math.floor(props.currentTime / 60)}:${String(Math.floor(props.currentTime % 60)).padStart(2, "0")}`;
});
const durationString = computed(() => {
  return `${Math.floor(props.duration / 60)}:${String(Math.floor(props.duration % 60)).padStart(2, "0")}`;
});
</script>

<template>
  <div class="flex items-center text-sm font-mono tabular-nums" v-bind="$attrs">
    <span class="opacity-80"> {{ currentTimeString }} </span>
    <span class="opacity-30 ml-2 mr-1">/</span>
    <span class="opacity-80"> {{ durationString }} </span>
  </div>
</template>
