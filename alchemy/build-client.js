// @ts-check
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {string} configFile
 * @param {string} outDir
 * @param {import("../client/settings.ts").ClientSettings} settings
 * @param {string} [iconsDir]
 */
export async function buildClient(configFile, outDir, settings, iconsDir) {
  const vite = createRequire(configFile).resolve("vite");
  const { build } = await import(pathToFileURL(vite).href);
  await build({
    build: { outDir },
    configFile,
    define: { __TABLETOP__: JSON.stringify(settings) },
    logLevel: "warn",
    ...(iconsDir === undefined ? {} : { publicDir: resolve(iconsDir) }),
  });
}
