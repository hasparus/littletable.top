// node scripts/boards-ssr/live.mjs <preview origin> [--sign-in]
// With --sign-in, complete normal login in each window using a benchmark account
// with a board on each deployment. Session data stays in memory for this run.
import { chromium } from "@playwright/test";

const preview = new URL(process.argv[2]).origin;
const sites = [preview, "https://littletable.top"];
const signedIn = process.argv.includes("--sign-in");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: !signedIn,
});
const sessions = new Map();
const samples = new Map(sites.map((site) => [site, []]));
try {
  if (signedIn) {
    for (const site of sites) {
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(site + "/boards?lang=en");
      console.log("Sign in and open the boards list at", site);
      await tab.locator('main a[href^="/b/"]').first().waitFor({ timeout: 300000 });
      sessions.set(site, await context.storageState());
      await context.close();
    }
  }
  const selector = signedIn ? 'main a[href^="/b/"]' : 'a[href^="/auth/sign-in"]';
  for (let pair = 0; pair <= 10; pair++) {
    for (const site of pair % 2 ? sites.toReversed() : sites) {
      const context = await browser.newContext({
        locale: "en-US",
        storageState: sessions.get(site),
      });
      try {
        const tab = await context.newPage();
        await tab.addInitScript((selector) => {
          function frame() {
            const target = document.querySelector(selector);
            if (target?.getBoundingClientRect().width) performance.mark("list-visible");
            else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }, selector);
        const response = await tab.goto(site + "/boards?lang=en", { waitUntil: "commit" });
        if (!response.ok()) throw Error("Document status " + response.status());
        await tab.waitForFunction(() => performance.getEntriesByName("list-visible").length > 0);
        const values = await tab.evaluate(() => [
          performance.getEntriesByType("navigation")[0].responseStart,
          performance.getEntriesByName("list-visible")[0].startTime,
        ]);
        if (pair) samples.get(site).push(values);
      } finally {
        await context.close();
      }
    }
  }
  for (const [site, rows] of samples) {
    const medians = [0, 1].map((i) => {
      const sorted = rows.map((row) => row[i]).sort((a, b) => a - b);
      return Math.round((sorted[4] + sorted[5]) / 2);
    });
    console.log(
      site,
      "median TTFB / first frame with visible",
      signedIn ? "board title" : "sign-in link",
      "(ms)",
      ...medians,
    );
  }
} finally {
  await browser.close();
}
