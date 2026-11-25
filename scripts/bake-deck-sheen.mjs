import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const bundle = await build({
  configFile: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warn",
  build: {
    write: false,
    target: "esnext",
    lib: {
      entry: fileURLToPath(new URL("materials/deck-sheen.mjs", import.meta.url)),
      formats: ["iife"],
      name: "deckMaterial",
    },
  },
});
const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  await page.route("https://bake.test/", (route) => route.fulfill({ body: "<!doctype html>" }));
  await page.goto("https://bake.test/");
  await page.addScriptTag({ content: bundle[0].output[0].code });
  const uri = await page.evaluate(() => globalThis.deckMaterial.bake());
  await writeFile(
    new URL("../client/src/deck-sheen.webp", import.meta.url),
    Buffer.from(uri.split(",")[1], "base64"),
  );
} finally {
  await browser.close();
}
