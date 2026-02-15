<script setup lang="ts">
import { Maximize2 } from "lucide-vue-next";
</script>

<template>
  <button
    class="hover:bg-white/10 p-2 rounded-full transition-all active:scale-90 cursor-pointer"
    v-bind="$attrs"
  >
    <Maximize2 class="size-6" />
  </button>
</template>
