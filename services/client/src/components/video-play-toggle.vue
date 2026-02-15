<script setup lang="ts">
import { Pause, Play } from "lucide-vue-next";

const isPlaying = defineModel<boolean>("isPlaying", { default: false });
const emit = defineEmits<(e: "togglePlay") => void>();
</script>

<template>
  <button
    @click="emit('togglePlay')"
    class="hover:bg-white/10 p-2 rounded-full transition-all active:scale-90 cursor-pointer"
  >
    <Pause v-if="isPlaying" class="size-7 fill-white" />
    <Play v-else class="size-7 fill-white" />
  </button>
</template>
