import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/learnbuddy/",
  server: {
    port: 5178,
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
  },
});
