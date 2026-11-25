import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { THEME_COLOR } from "../client/settings";

// Run with Bun and Playwright Chromium installed: bun scripts/app-icons.ts
const publicDir = new URL("../client/public/", import.meta.url);
const mark = await readFile(new URL("table-mark.svg", import.meta.url));
const icons = [
  { filename: "icon-192.png", size: 192 },
  { filename: "icon-512.png", size: 512 },
  { filename: "icon-1024.png", size: 1024 },
  { background: THEME_COLOR, filename: "apple-touch-icon.png", size: 180 },
  { background: THEME_COLOR, filename: "icon-maskable-512.png", size: 512, width: "84%" },
];

const browser = await chromium.launch({ args: ["--ozone-platform=headless"] });
try {
  const page = await browser.newPage({ colorScheme: "light" });
  for (const { background, filename, size, width = "100%" } of icons) {
    await page.setViewportSize({ height: size, width: size });
    await page.setContent(`<!doctype html><style>
      body { background: ${background ?? "transparent"}; display: grid; margin: 0; min-height: 100vh; place-items: center; }
      img { display: block; width: ${width}; }
      </style><img src="data:image/svg+xml;base64,${mark.toString("base64")}" alt="">`);
    await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    await page.screenshot({
      omitBackground: background === undefined,
      path: fileURLToPath(new URL(filename, publicDir)),
    });
  }
} finally {
  await browser.close();
}
