import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/learnbuddy/",
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      "/api/learnbuddy": {
        target: "http://129.204.52.57:3088",
        changeOrigin: true,
      },
      "^/(?!learnbuddy(?:/|\\?|$)|@|node_modules/)": {
        target: "http://129.204.52.57:3088",
        changeOrigin: true,
        ws: true,
      },
    },
    hmr: { path: "/learnbuddy/hmr" },
    watch: { usePolling: true, interval: 500 },
  },
});
