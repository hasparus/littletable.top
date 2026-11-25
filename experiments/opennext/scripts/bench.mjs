import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const server = new URL(process.argv[2] ?? "http://localhost:18620");
assert.ok(
  server.protocol === "http:" && ["localhost", "127.0.0.1"].includes(server.hostname),
  "Run the fixture benchmark against the local experiment server",
);
const origin = server.origin;
const samples = Number(process.env.BENCH_SAMPLES ?? 10);
assert.ok(Number.isInteger(samples) && samples > 0, "BENCH_SAMPLES must be a positive integer");

const title = "Benchmark board";
const variants = [
  { name: "vite-worker", query: "" },
  { name: "opennext", query: "renderer=opennext" },
];
const routes = [
  {
    name: "landing",
    path: "/",
    selector: "[data-landing-preview]",
    ready: "[data-board-shell]:not([hidden]) [data-board-editor]:not([inert]) [data-testid=canvas]",
  },
  {
    name: "signed-in boards",
    path: "/boards",
    selector: 'main a[href^="/b/"]',
  },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const setup = await browser.newContext();
  let state;
  try {
    const start = await setup.request.get(origin + "/auth/sign-in?return=/boards", {
      maxRedirects: 0,
    });
    assert.equal(start.status(), 302);
    const authorize = new URL(start.headers().location);
    authorize.searchParams.set("fake_user", "OpenNext benchmark " + randomUUID());
    const authenticated = await setup.request.get(authorize.href);
    assert.equal(authenticated.url(), origin + "/boards");
    const me = await setup.request.get(origin + "/api/me");
    assert.ok(me.ok());
    const { csrf } = await me.json();
    const board = await setup.request.post(origin + "/api/boards", {
      data: { title },
      headers: { Origin: origin, "X-CSRF-Token": csrf },
    });
    assert.equal(board.status(), 201);
    state = await setup.storageState();
  } finally {
    await setup.close();
  }

  for (const variant of variants) {
    const documentOnly = await browser.newContext({
      javaScriptEnabled: false,
      storageState: state,
    });
    try {
      const page = await documentOnly.newPage();
      const query = variant.query ? "&" + variant.query : "";
      const response = await page.goto(origin + "/boards?lang=en" + query);
      assert.equal(response.status(), 200);
      assert.equal((await response.allHeaders())["cache-control"], "private, no-store");
      await page.getByRole("link", { name: title, exact: true }).waitFor();
      if (variant.query) {
        await page.goto(origin + "/?" + variant.query);
        await page.locator("[data-landing-preview]").waitFor();
      }
    } finally {
      await documentOnly.close();
    }
  }

  const guest = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await guest.newPage();
    await page.goto(origin + "/boards?lang=en&renderer=opennext");
    await page.getByRole("link", { name: "Sign in" }).waitFor();
    assert.equal(await page.getByRole("link", { name: title, exact: true }).count(), 0);
  } finally {
    await guest.close();
  }

  const results = [];
  for (const route of routes) {
    for (let pair = 0; pair <= samples; pair++) {
      for (const variant of pair % 2 === 0 ? variants : variants.toReversed()) {
        const context = await browser.newContext({
          locale: "en-US",
          storageState: route.name === "signed-in boards" ? state : undefined,
        });
        try {
          const page = await context.newPage();
          await page.addInitScript(({ selector, ready }) => {
            const marks = [["little-table-bench-visible", selector]];
            if (ready) marks.push(["little-table-bench-canvas", ready]);
            function frame() {
              for (const [name, target] of marks) {
                const element = document.querySelector(target);
                if (
                  element?.getBoundingClientRect().width &&
                  element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                ) {
                  if (!performance.getEntriesByName(name, "mark").length) performance.mark(name);
                }
              }
              if (marks.some(([name]) => !performance.getEntriesByName(name, "mark").length)) {
                requestAnimationFrame(frame);
              }
            }
            requestAnimationFrame(frame);
          }, route);
          const query = new URLSearchParams(variant.query);
          if (route.path === "/boards") query.set("lang", "en");
          const suffix = query.size ? "?" + query : "";
          const response = await page.goto(origin + route.path + suffix);
          assert.equal(response.status(), 200);
          assert.equal(
            (await response.allHeaders())["x-little-table-renderer"],
            variant.name === "opennext" ? "opennext" : undefined,
          );
          await page.waitForFunction(
            (ready) =>
              performance.getEntriesByName("first-contentful-paint").length &&
              performance.getEntriesByName("little-table-bench-visible", "mark").length &&
              (!ready || performance.getEntriesByName("little-table-bench-canvas", "mark").length),
            Boolean(route.ready),
            { timeout: 20_000 },
          );
          const metrics = await page.evaluate(() => {
            const nav = performance.getEntriesByType("navigation")[0];
            return {
              ttfbMs: nav.responseStart,
              firstContentfulPaintMs:
                performance.getEntriesByName("first-contentful-paint")[0].startTime,
              firstVisibleMs: performance.getEntriesByName("little-table-bench-visible", "mark")[0]
                .startTime,
              canvasVisibleMs: performance.getEntriesByName("little-table-bench-canvas", "mark")[0]
                ?.startTime,
              htmlBytes: nav.decodedBodySize,
            };
          });
          assert.ok(metrics.firstVisibleMs >= metrics.ttfbMs);
          if (pair) results.push({ route: route.name, renderer: variant.name, pair, ...metrics });
        } finally {
          await context.close();
        }
      }
    }
  }

  const middle = (values) => {
    const sorted = values.filter((value) => value !== undefined).toSorted((a, b) => a - b);
    if (!sorted.length) return undefined;
    return Math.round(
      (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    );
  };
  const medians = routes.flatMap((route) =>
    variants.map((variant) => {
      const rows = results.filter(
        ({ route: name, renderer }) => name === route.name && renderer === variant.name,
      );
      return {
        route: route.name,
        renderer: variant.name,
        ...Object.fromEntries(
          [
            "ttfbMs",
            "firstContentfulPaintMs",
            "firstVisibleMs",
            "canvasVisibleMs",
            "htmlBytes",
          ].map((metric) => [metric, middle(rows.map((row) => row[metric]))]),
        ),
      };
    }),
  );
  console.log(JSON.stringify({ samples, medians, results }, null, 2));
} finally {
  await browser.close();
}
