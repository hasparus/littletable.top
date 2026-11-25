// node scripts/bench-landing-prerender.mjs <control origin> <prerender origin>
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const variants = [
  { name: "client", url: new URL("/", process.argv[2]).href },
  { name: "prerender", url: new URL("/", process.argv[3]).href },
];
const rows = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

try {
  for (let pair = 0; pair <= 10; pair++) {
    for (const variant of pair % 2 === 0 ? variants : variants.toReversed()) {
      const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        viewport: { width: 390, height: 844 },
      });
      try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.addInitScript(() => {
          const font = '15px "Landing handwriting"';
          const canvasSelector =
            "[data-board-shell]:not([hidden]) [data-board-editor]:not([inert]) [data-testid=canvas]";
          function mark(name, element) {
            if (
              element?.getBoundingClientRect().width &&
              element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
              !performance.getEntriesByName(name).length
            ) {
              performance.mark(name);
            }
          }
          function measure() {
            const intro = document.querySelector(
              "[data-landing-preview] p, [data-public-board-note] p",
            );
            if (
              intro &&
              getComputedStyle(intro).fontFamily.includes("Landing handwriting") &&
              document.fonts.check(font)
            ) {
              mark("intro-visible", intro);
            }
            mark("canvas-visible", document.querySelector(canvasSelector));
            if (
              !performance.getEntriesByName("canvas-visible").length ||
              !performance.getEntriesByName("intro-visible").length
            ) {
              requestAnimationFrame(measure);
            }
          }
          requestAnimationFrame(measure);
        });
        const response = await page.goto(variant.url, { waitUntil: "commit" });
        assert.equal(response?.status(), 200);
        const ready = page.getByTestId("canvas");
        await ready.click({ trial: true });
        await page.waitForFunction(
          () =>
            performance.getEntriesByName("intro-visible").length &&
            performance.getEntriesByName("canvas-visible").length,
        );
        const sample = await page.evaluate(() => ({
          introMs: performance.getEntriesByName("intro-visible")[0].startTime,
          canvasMs: performance.getEntriesByName("canvas-visible")[0].startTime,
          ttfbMs: performance.getEntriesByType("navigation")[0].responseStart,
        }));
        const html = await response.text();
        assert.equal(html.includes("<section data-landing-preview"), variant.name === "prerender");
        if (pair) rows.push({ pair, variant: variant.name, ...sample });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const medians = variants.map(({ name: variant }) => {
  const samples = rows.filter((row) => row.variant === variant);
  return {
    variant,
    ttfbMs: median(samples.map((row) => row.ttfbMs)),
    introMs: median(samples.map((row) => row.introMs)),
    canvasMs: median(samples.map((row) => row.canvasMs)),
  };
});
console.log(JSON.stringify({ medians, rows }, null, 2));
