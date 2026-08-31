import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts (design §10): that config hard-requires an
// INPUT env var (vite.config.ts:5-8) and applies vite-plugin-singlefile for
// the four widget bundles, which is wrong for a normal multi-asset SPA build.
export default defineConfig({
  root: "ui/assistant",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../../dist/assistant",
    emptyOutDir: true,
  },
  server: {
    // "dev:assistant" convenience: proxy API calls to the backend, which is
    // started separately via "npm run assistant" on ASSISTANT_PORT (3002).
    proxy: {
      "/api": "http://127.0.0.1:3002",
    },
  },
});
