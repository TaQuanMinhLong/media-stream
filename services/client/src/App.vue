<script setup lang="ts">
import MediaPlayer from "./components/media-player.vue";
</script>

<template>
  <main class="min-h-screen flex items-center justify-center bg-gray-900 p-4">
    <MediaPlayer :encrypted="true" asset-id="sample" />
  </main>
</template>
