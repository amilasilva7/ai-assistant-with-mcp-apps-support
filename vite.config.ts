import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set (see the build script in package.json)");
}

// vite-plugin-singlefile inlines JS/CSS into one HTML file so each widget can
// be served as-is from a ui:// resource with a deny-by-default CSP (no
// external requests). It only supports a single entry per build, so each
// widget is built with its own `vite build` invocation (see package.json).
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: INPUT,
    },
  },
});
