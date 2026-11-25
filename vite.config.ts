import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

import {
  BRAND_PROPERTIES,
  type Brand,
  type ClientSettings,
  DEFAULT_SETTINGS,
  THEME_COLOR,
} from "./client/settings";
import { LANDING_COPY } from "./client/src/front-copy";
import { boardShell } from "./client/src/front-skeleton";

// The tabletop's client in client/, built into dist/, which the Worker
// serves (wrangler.json "assets"). `bun run dev` serves it here with hot
// reload and sends the API and the rooms socket on to the Worker that
// `bun run dev:worker` runs.

const WORKER_DEV_PORT = 8789;
const SHARE_IMAGES = ["open-graph.png", "open-graph-board.png"];
// Hosted builds compile this client's source from an installed package.
const clientSource = normalizePath(fileURLToPath(new URL("client/src/", import.meta.url)));
const compilerFiles = new RegExp(
  `^${clientSource.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*\\.[jt]sx?(?:$|\\?)`,
  "u",
);

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

const LANDING_PREVIEW = `<section data-landing-preview data-prerendered lang="en" aria-label="${escapeHtml(LANDING_COPY.publicBoard)}">${LANDING_COPY.publicStory
  .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
  .join("")}<footer>${escapeHtml(LANDING_COPY.publicExpiry)}</footer></section>`;

const BRAND_MODULE = "virtual:tabletop-brand.css";

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
      if (settings.mode === "standalone") {
        for (const fileName of SHARE_IMAGES) {
          this.emitFile({
            fileName,
            source: readFileSync(new URL(`client/${fileName}`, import.meta.url)),
            type: "asset",
          });
        }
      }
    },
    load(id) {
      return id === `\0${BRAND_MODULE}` ? brandCss(settings.brand) : null;
    },
    name: "tabletop",
    resolveId(id) {
      return id === BRAND_MODULE ? `\0${BRAND_MODULE}` : null;
    },
    transformIndexHtml(html, { bundle, originalUrl }) {
      if (!bundle && settings.mode === "standalone" && originalUrl?.split("?")[0] === "/boards") {
        html = html.replace("<!-- boards-shell -->", boardShell);
      }
      if (settings.mode === "standalone" && !bundle && originalUrl?.split("?")[0] === "/") {
        html = html.replace("<!-- landing-preview -->", LANDING_PREVIEW);
      }
      if (settings.mode === "standalone" && bundle) {
        html = html.replace(
          "<!-- landing-preview -->",
          `<template data-landing-prerender>${LANDING_PREVIEW}</template>`,
        );
        const board = Object.values(bundle).find(
          (chunk) => chunk.type === "chunk" && chunk.facadeModuleId === clientSource + "board.tsx",
        );
        if (board?.type !== "chunk") throw new Error("Missing board entry chunk");
        const modules = new Set<string>();
        const styles = new Set<string>();
        function visit(file: string) {
          const chunk = bundle?.[file];
          if (chunk?.type !== "chunk" || modules.has(file)) return;
          modules.add(file);
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
          for (const imported of chunk.imports) visit(imported);
        }
        visit(board.fileName);
        const handwriting = Object.values(bundle).find(
          (file) =>
            file.type === "asset" && file.names.includes("Shantell_Sans-Informal_Regular.woff2"),
        );
        if (!handwriting) throw new Error("Missing landing handwriting font");
        const hints = [
          `<link rel="preload" as="font" type="font/woff2" crossorigin href="/${escapeHtml(handwriting.fileName)}">`,
          ...Array.from(
            modules,
            (file) => `<link rel="modulepreload" crossorigin href="/${escapeHtml(file)}">`,
          ),
          ...Array.from(
            styles,
            (file) => `<link rel="preload" as="style" crossorigin href="/${escapeHtml(file)}">`,
          ),
        ];
        // The Worker unwraps these inert hints only for the standalone public board.
        html = html.replace(
          "</head>",
          `<template data-board-preloads>${hints.join("")}</template></head>`,
        );
      }
      return html
        .replaceAll("%TABLETOP_NAME%", escapeHtml(settings.name))
        .replaceAll("%TABLETOP_SHORT_NAME%", escapeHtml(settings.shortName))
        .replaceAll("%TABLETOP_LANGUAGE%", settings.language)
        .replaceAll("%TABLETOP_THEME_COLOR%", THEME_COLOR);
    },
  };
}

const require = createRequire(import.meta.url);
const ocr = (name: string) => fileURLToPath(new URL(`client/ocr/${name}`, import.meta.url));

// The files the text engines load at run time, by what the worker calls
// them (client/src/text-worker.ts); ONNX Runtime's WebAssembly is not
// among them, as Vite emits it from the runtime's own reference. They stay files, fetched only when an
// image is read: each under /assets/ocr/ with its content's hash in its
// name, or, for Tesseract's language data, whose names it fixes, in its
// folder's. docs/internals.md, "Text in images", says where each comes from.
const ENGINE_FILES = {
  detector: { from: ocr("ppocr-v6-tiny-det.onnx"), name: "ppocr-v6-tiny-det.onnx" },
  recogniser: { from: ocr("ppocr-v6-tiny-rec.onnx"), name: "ppocr-v6-tiny-rec.onnx" },
  tesseractCore: {
    from: require.resolve("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"),
    name: "tesseract-core-simd-lstm.wasm.js",
  },
  tesseractCoreNoSimd: {
    from: require.resolve("tesseract.js-core/tesseract-core-lstm.wasm.js"),
    name: "tesseract-core-lstm.wasm.js",
  },
  tesseractWorker: {
    from: require.resolve("tesseract.js/dist/worker.min.js"),
    name: "tesseract-worker.min.js",
  },
} as const;
const LANGUAGES = ["eng", "pol"].map((language) => ({
  from: ocr(`tessdata/${language}.traineddata.gz`),
  name: `${language}.traineddata.gz`,
}));

const hashOf = (...sources: Buffer[]) => {
  const hash = createHash("sha256");
  for (const source of sources) hash.update(source);
  return hash.digest("hex").slice(0, 10);
};

const ENGINE_MODULE = "virtual:text-engine-files";
const SERVED_AS: Record<string, string> = {
  ".gz": "application/gzip",
  ".js": "text/javascript",
  ".onnx": "application/octet-stream",
  ".wasm": "application/wasm",
};

function textEngineFiles(): Plugin {
  let serving = false;
  const served = new Map<string, string>();
  const layout = () => {
    const files = Object.entries(ENGINE_FILES).map(([key, { from, name }]) => {
      const source = readFileSync(from);
      const dot = name.indexOf(".");
      return {
        key,
        path: `assets/ocr/${name.slice(0, dot)}-${hashOf(source)}${name.slice(dot)}`,
        source,
      };
    });
    const languages = LANGUAGES.map(({ from, name }) => ({ name, source: readFileSync(from) }));
    const folder = `assets/ocr/tessdata-${hashOf(...languages.map(({ source }) => source))}`;
    return { files, folder, languages };
  };
  return {
    configResolved(config) {
      serving = config.command === "serve";
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const from = served.get(request.url?.split("?")[0] ?? "");
        if (from === undefined) return next();
        response.setHeader(
          "Content-Type",
          SERVED_AS[from.slice(from.lastIndexOf("."))] ?? "application/octet-stream",
        );
        response.end(readFileSync(from));
      });
    },
    load(id) {
      if (id !== `\0${ENGINE_MODULE}`) return null;
      const { files, folder, languages } = layout();
      const urls: Record<string, string> = { tessdata: `/${folder}` };
      for (const { key, path, source } of files) {
        urls[key] = `/${path}`;
        if (serving) served.set(`/${path}`, ENGINE_FILES[key as keyof typeof ENGINE_FILES].from);
        else this.emitFile({ fileName: path, source, type: "asset" });
      }
      for (const [at, { name, source }] of languages.entries()) {
        if (serving) served.set(`/${folder}/${name}`, LANGUAGES[at]!.from);
        else this.emitFile({ fileName: `${folder}/${name}`, source, type: "asset" });
      }
      return `export default ${JSON.stringify(urls)};`;
    },
    name: "text-engine-files",
    resolveId(id) {
      return id === ENGINE_MODULE ? `\0${ENGINE_MODULE}` : null;
    },
  };
}

// Only the practice table uses this local shelf. Real board installs go through the room.
function practicePackages(): Plugin {
  const root = new URL("gizmos/", import.meta.url);
  const types: Record<string, string> = {
    json: "application/json",
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    avif: "image/avif",
  };
  function files() {
    const assets = new Map<string, { source: URL; type: string }>();
    const manifests: string[] = [];
    function visit(folder: URL, prefix: string) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = prefix + entry.name;
        const source = new URL(entry.name + (entry.isDirectory() ? "/" : ""), folder);
        if (entry.isDirectory()) visit(source, path + "/");
        if (!entry.isFile()) continue;
        const extension = entry.name.split(".").at(-1) ?? "";
        if (extension === "json") {
          if (!/^gizmos\/[\w-]+\/gizmo\.json$/u.test(path)) continue;
          manifests.push("/" + path);
        }
        if (types[extension]) assets.set(path, { source, type: types[extension] });
      }
    }
    visit(root, "gizmos/");
    return { assets, catalog: JSON.stringify(manifests.sort()) };
  }
  return {
    name: "gizmo-practice-packages",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.split("?")[0] === "/research/gizmos/")
          request.url = request.url.replace("/research/gizmos/", "/research/gizmos/index.html");
        next();
      });
      server.middlewares.use("/gizmos/", (request, response, next) => {
        const path = "gizmos" + request.url?.split("?")[0];
        const { assets, catalog } = files();
        if (path === "gizmos/catalog.json") {
          response.setHeader("Content-Type", types.json!);
          response.end(catalog);
          return;
        }
        const asset = assets.get(path);
        if (!asset) return next();
        response.setHeader("Content-Type", asset.type);
        response.end(readFileSync(asset.source));
      });
    },
    generateBundle() {
      const { assets, catalog } = files();
      this.emitFile({ type: "asset", fileName: "gizmos/catalog.json", source: catalog });
      for (const [fileName, asset] of assets)
        this.emitFile({ type: "asset", fileName, source: readFileSync(asset.source) });
    },
  };
}

export default defineConfig({
  build: {
    // WARNING: Keep tldraw fonts as files. The tabletop’s CSP forbids data: fonts and cross-origin fonts.
    assetsInlineLimit: (file) => (file.includes("@tldraw/assets") ? false : undefined),
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("dist", import.meta.url)),
    sourcemap: true,
  },
  define: { __TABLETOP__: JSON.stringify(settingsFromEnv()) },
  // WARNING: The Vite dependency pre-bundler cannot follow @tldraw/assets’ ?url imports. Serve that package as-is.
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  plugins: [
    react(),
    babel({
      include: compilerFiles,
      exclude: [],
      presets: [
        reactCompilerPreset({ sources: (filename) => compilerFiles.test(normalizePath(filename)) }),
      ],
    }),
    tailwindcss(),
    tabletop(),
    practicePackages(),
    textEngineFiles(),
  ],
  publicDir: fileURLToPath(new URL("client/public", import.meta.url)),
  worker: { format: "es", plugins: () => [textEngineFiles()] },
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
