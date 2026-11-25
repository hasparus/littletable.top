import { chromium } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
// NODE_ENV=production node scripts/boards-ssr/bench.mjs
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "vite";

const folder = "scripts/boards-ssr";
const cache = resolve("node_modules/.cache");
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(join(cache, "boards-"));
const timing = {
  name: "benchmark-element-timing",
  enforce: "pre",
  transform(code, id) {
    if (id.endsWith("/front-board-list.tsx"))
      return code.replaceAll(
        "<a className={BOARD_LINK}",
        '<a elementtiming="board-title" className={BOARD_LINK}',
      );
  },
};
const common = {
  configFile: false,
  plugins: [timing],
  logLevel: "error",
  oxc: { jsx: { runtime: "automatic" } },
};
const pageData = {
  account: { avatar: null, id: "bench", name: "Bench" },
  csrf: "fixture",
  owned: [{ createdAt: 1700000000, id: "one", shareCode: "one", title: "Benchmark table" }],
  visited: [],
};
let server;
let browser;
try {
  await build({
    ...common,
    plugins: [timing, tailwind()],
    build: {
      outDir: join(temp, "client"),
      rolldownOptions: {
        input: resolve(folder, "client.tsx"),
        output: { entryFileNames: "client.js", assetFileNames: "assets/[name][extname]" },
      },
    },
  });
  await build({
    ...common,
    build: {
      ssr: resolve(folder, "server.tsx"),
      outDir: join(temp, "server"),
      rolldownOptions: { output: { entryFileNames: "server.mjs" } },
    },
  });
  const { boardShell, render } = await import(join(temp, "server/server.mjs"));
  server = createServer(async (req, res) => {
    const path = req.url;
    if (path === "/ssr" || path === "/shell") {
      const ssr = path === "/ssr";
      if (ssr) await delay(10);
      const state = ssr
        ? `<script type="application/json" id="initial-page">${JSON.stringify(pageData).replaceAll("<", "\\u003c")}</script>`
        : "";
      res.writeHead(200, { "content-type": "text/html", "cache-control": "private, no-store" });
      res.end(
        `<!doctype html><html lang="en"><link rel="stylesheet" href="/assets/client.css"><body><div class="fixed inset-0 overflow-y-auto bg-background" data-board-root>${ssr ? render(pageData) : boardShell}</div>${state}<script type="module" src="/client.js"></script></body></html>`,
      );
    } else if (path === "/api/boards") {
      await delay(10);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pageData));
    } else if (
      path === "/client.js" ||
      path === "/assets/client.css" ||
      /^\/assets\/[\w.-]+\.woff2$/.test(path)
    ) {
      res
        .writeHead(200, {
          "content-type": path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "font/woff2",
        })
        .end(await readFile(join(temp, "client", path)));
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const samples = { shell: [], ssr: [] };
  for (let pair = 0; pair < 11; pair++) {
    for (const mode of pair % 2 ? ["ssr", "shell"] : ["shell", "ssr"]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 50,
          downloadThroughput: 1500000,
          uploadThroughput: 750000,
        });
        await page.addInitScript(() => {
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries())
              if (entry.identifier === "board-title") window.titlePaint = entry.startTime;
          }).observe({ type: "element", buffered: true });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/${mode}`, {
          waitUntil: "commit",
        });
        await page.waitForFunction(() => window.titlePaint > 0);
        await page.locator('summary[aria-label="Manage Benchmark table"]').click();
        const rename = page.getByRole("button", { name: "Rename", exact: true });
        await rename.click();
        const editor = page.getByRole("textbox", { name: "Board name" });
        if (!(await editor.isVisible())) {
          await page.waitForLoadState("load");
          if (!(await editor.isVisible())) await rename.click();
        }
        await editor.waitFor();
        const row = await page.evaluate(() => [
          performance.getEntriesByType("navigation")[0].responseStart,
          window.titlePaint,
          performance.now(),
        ]);
        if (errors.length) throw Error(errors.join("\n"));
        if (pair) samples[mode].push(row);
      } finally {
        await context.close();
      }
    }
  }
  for (const [mode, rows] of Object.entries(samples)) {
    console.log(
      mode,
      "median ms [TTFB, board title paint, rename editor observed]",
      [0, 1, 2].map((i) => {
        const values = rows.map((row) => row[i]).sort((a, b) => a - b);
        return Math.round((values[4] + values[5]) / 2);
      }),
    );
  }
} finally {
  await browser?.close();
  server?.close();
  await rm(temp, { recursive: true, force: true });
}
