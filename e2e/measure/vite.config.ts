import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The text-measurement harness: a bare tldraw editor with tldraw's own
// fonts, which e2e/measure.config.ts asks for sizes. Not part of the app.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // NOTE: as in the app, tldraw's assets stay files Vite serves as they are.
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { port: Number(process.env.MEASURE_PORT ?? 8797), strictPort: true },
});
