import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import {
  BRAND_PROPERTIES,
  type Brand,
  type ClientSettings,
  DEFAULT_SETTINGS,
  THEME_COLOR,
} from "./client/settings";

// The tabletop's client in client/, built into dist/, which the Worker
// serves (wrangler.json "assets"). `aube run dev` serves it here with hot
// reload and sends the API and the rooms socket on to the Worker that
// `aube run dev:worker` runs.

const WORKER_DEV_PORT = 8789;

// A laptop's build: TABLETOP_MODE=standalone, or a hosted client of
// TABLETOP_HOST_ORIGIN. Alchemy builds pass the whole value instead
// (alchemy/index.js).
function settingsFromEnv(): ClientSettings {
  const licenseKey = process.env.TLDRAW_LICENSE_KEY ?? "";
  if (process.env.TABLETOP_MODE === "standalone") return { ...DEFAULT_SETTINGS, licenseKey };
  const hostOrigin = process.env.TABLETOP_HOST_ORIGIN ?? "http://localhost:8000";
  return {
    ...DEFAULT_SETTINGS,
    hosted: { bootstrapUrl: `${hostOrigin}/b/{code}/bootstrap/`, exitUrl: `${hostOrigin}/` },
    licenseKey,
    mode: "hosted",
  };
}

const COLOUR = /^#[\da-f]{3,8}$/iu;

function brandCss(brand: Partial<Brand>): string {
  const declarations = Object.entries(brand).map(([name, value]) => {
    if (!(name in BRAND_PROPERTIES)) throw new Error(`tabletop: unknown brand colour ${name}`);
    if (typeof value !== "string" || !COLOUR.test(value)) {
      throw new Error(`tabletop: brand.${name} must be a hex colour, not ${String(value)}`);
    }
    return `${BRAND_PROPERTIES[name as keyof Brand]}: ${value};`;
  });
  return declarations.length === 0 ? "" : `:root { ${declarations.join(" ")} }\n`;
}

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const BRAND_MODULE = "virtual:tabletop-brand.css";

// Writes what depends on the settings: the page's title and language, the
// brand colours, and the web app manifest.
function tabletop(): Plugin {
  let settings = DEFAULT_SETTINGS;
  const manifest = () =>
    JSON.stringify(
      {
        background_color: THEME_COLOR,
        description: settings.description,
        display: "standalone",
        icons: [
          { purpose: "any", sizes: "192x192", src: "/icon-192.png", type: "image/png" },
          { purpose: "any", sizes: "512x512", src: "/icon-512.png", type: "image/png" },
          { purpose: "any", sizes: "1024x1024", src: "/icon-1024.png", type: "image/png" },
          {
            purpose: "maskable",
            sizes: "512x512",
            src: "/icon-maskable-512.png",
            type: "image/png",
          },
        ],
        lang: settings.language,
        name: settings.name,
        scope: settings.mode === "hosted" ? "/b/" : "/",
        short_name: settings.shortName,
        theme_color: THEME_COLOR,
      },
      null,
      2,
    );
  return {
    configResolved(config) {
      const value = config.define?.__TABLETOP__;
      if (typeof value === "string") settings = JSON.parse(value) as ClientSettings;
    },
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_request, response) => {
        response.setHeader("Content-Type", "application/manifest+json");
        response.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ fileName: "manifest.webmanifest", source: manifest(), type: "asset" });
    },
    load(id) {
      return id === `\0${BRAND_MODULE}` ? brandCss(settings.brand) : null;
    },
    name: "tabletop",
    resolveId(id) {
      return id === BRAND_MODULE ? `\0${BRAND_MODULE}` : null;
    },
    transformIndexHtml(html) {
      return html
        .replaceAll("%TABLETOP_NAME%", escapeHtml(settings.name))
        .replaceAll("%TABLETOP_SHORT_NAME%", escapeHtml(settings.shortName))
        .replaceAll("%TABLETOP_LANGUAGE%", settings.language)
        .replaceAll("%TABLETOP_THEME_COLOR%", THEME_COLOR);
    },
  };
}

export default defineConfig({
  build: {
    // NOTE: tldraw's fonts and translations stay files: the tabletop's
    // Content-Security-Policy allows no data: fonts and no host but its own.
    assetsInlineLimit: (file) => (file.includes("@tldraw/assets") ? false : undefined),
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("dist", import.meta.url)),
    sourcemap: true,
  },
  define: { __TABLETOP__: JSON.stringify(settingsFromEnv()) },
  // NOTE: the dependency pre-bundler cannot follow @tldraw/assets' `?url`
  // imports; Vite serves the package as it is instead.
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  plugins: [tailwindcss(), tabletop()],
  publicDir: fileURLToPath(new URL("client/public", import.meta.url)),
  root: fileURLToPath(new URL("client", import.meta.url)),
  server: {
    port: 8788,
    proxy: {
      "/api": { target: `http://localhost:${WORKER_DEV_PORT}` },
      "/rooms": { target: `http://localhost:${WORKER_DEV_PORT}`, ws: true },
    },
    strictPort: true,
  },
});
