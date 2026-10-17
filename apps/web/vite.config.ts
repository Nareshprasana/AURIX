import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local-first: bind loopback only. `/api` is proxied same-origin to the
// read-only Python dashboard (default http://127.0.0.1:8742) so the session
// cookie stays same-site and no CORS exception is ever needed.
// Override with AURIX_API_TARGET=http://127.0.0.1:8742 pnpm dev
const apiTarget = process.env.AURIX_API_TARGET ?? "http://127.0.0.1:8742";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
