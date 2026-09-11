import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const dshTarget = env.LEARNBUDDY_DSH_TARGET || "http://129.204.52.57:3088";
  return {
  plugins: [react()],
  base: "/learnbuddy/",
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      "/api/learnbuddy": {
        target: env.LEARNBUDDY_API_TARGET || "http://129.204.52.57:3088",
        changeOrigin: true,
      },
      "^/(?!learnbuddy(?:/|\\?|$)|@|node_modules/)": {
        target: dshTarget,
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          // Preserve DSH's same-origin check across this local reverse proxy.
          const rewrite = (outgoing: { setHeader: (name: string, value: string) => void }, req: { headers: { origin?: string; host?: string } }) => {
            if (req.headers.origin && new URL(req.headers.origin).host === req.headers.host)
              outgoing.setHeader("Origin", new URL(dshTarget).origin);
          };
          proxy.on("proxyReq", rewrite);
          proxy.on("proxyReqWs", rewrite);
        },
      },
    },
    hmr: { path: "/learnbuddy/hmr" },
    watch: { usePolling: true, interval: 500 },
  },
  };
});
