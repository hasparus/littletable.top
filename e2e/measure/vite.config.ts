import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The text-measurement harness: a bare tldraw editor with tldraw's own
// fonts, which e2e/measure.config.ts asks for sizes. Not part of the app.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // NOTE: as in the app, tldraw's assets stay files Vite serves as they are.
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  // NOTE: tldraw's canvas-ops engine, as adapted in src/mcp/upstream, imports
  // our stand-in where the original imports "tldraw". In this harness the
  // same files get the real thing back, so the engine runs on a real Editor.
  resolve: { alias: [{ find: /^\.\.\/\.\.\/editor\/tldraw$/u, replacement: "tldraw" }] },
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    port: Number(process.env.MEASURE_PORT ?? 8797 + Number(process.env.E2E_PORT_OFFSET ?? 0)),
    strictPort: true,
  },
});
