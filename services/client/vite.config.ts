import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  worker: { format: "es" },
  server: {
    proxy: {
      "/media": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
      "/_assets": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
