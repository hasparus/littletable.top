import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

import { STANDALONE } from "../ports";
import { PHONE, reviewShot } from "./helpers";

// oxlint-disable landmines-testing/no-test-doubles -- Keep PostHog network traffic in Chromium's test routes.
const SDK_ASSETS = "https://us-assets.i.posthog.com";
const SDK_API = "https://us.i.posthog.com";
const WIDGET = "#ph-conversations-widget-container";
const CORS = { "access-control-allow-origin": "*" };

async function addPostHogToken(route: Route) {
  const response = await route.fetch();
  const headers = response.headers();
  delete headers["content-encoding"];
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  headers["content-security-policy"] = headers["content-security-policy"]!.replace(
    "connect-src 'self'",
    `connect-src 'self' ${SDK_ASSETS} ${SDK_API}`,
  ).replace("script-src 'self'", `script-src 'self' ${SDK_ASSETS}`);
  const html = await response.text();
  await route.fulfill({
    body: html.replace("</head>", '<meta name="posthog-project-token" content="phc_test"></head>'),
    headers,
    status: response.status(),
  });
}

async function mockSupport(context: BrowserContext) {
  await context.route(`${STANDALONE}/docs/?support`, addPostHogToken);
  await context.route(`${SDK_ASSETS}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/static/")) {
      await route.fulfill({
        contentType: "application/javascript",
        headers: CORS,
        path: `node_modules/posthog-js/dist/${path.split("/").at(-1)}`,
      });
      return;
    }
    await route.fulfill({
      headers: CORS,
      json: {
        conversations: {
          enabled: true,
          greetingText: "How can we help?",
          token: "widget-test",
          widgetEnabled: true,
        },
        hasFeatureFlags: false,
        supportedCompression: [],
      },
    });
  });
  await context.route(`${SDK_API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      headers: CORS,
      json: path.endsWith("/message")
        ? { message_id: "message-test", ticket_id: "ticket-test" }
        : { messages: [], status: 1 },
    });
  });
}

async function composer(page: Page) {
  const input = page.locator(WIDGET).locator("textarea");
  await expect(input).toBeVisible();
  return input;
}

test("the phone board menu opens the Support composer in a separate tab", async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE, reducedMotion: "reduce" });
  try {
    await mockSupport(context);
    const board = await context.newPage();
    await board.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (document.head === null) return;
        observer.disconnect();
        const meta = document.createElement("meta");
        meta.name = "little-table-support";
        document.head.append(meta);
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await board.goto(`${STANDALONE}/?lang=en`);
    await board.getByTestId("main-menu.button").click();
    const support = board.getByRole("menuitem", { name: "Open support in a new tab" });
    await expect(support).toBeVisible();
    await reviewShot(board, "support-phone-menu");
    const opened = context.waitForEvent("page", { timeout: 10_000 });
    await support.click();
    const help = await opened;
    await expect(help).toHaveURL(`${STANDALONE}/docs/?support`);
    expect(await help.evaluate(() => document.referrer)).toBe("");
    const input = await composer(help);
    await input.fill("The dice roll is hard to read on a small screen.");
    await reviewShot(help, "support-phone-ticket");
    const sent = help.waitForRequest(`${SDK_API}/api/conversations/v1/widget/message`);
    await help.locator(WIDGET).getByRole("button", { name: /send/iu }).click();
    const request = await sent;
    expect(request.postDataJSON()).toMatchObject({
      message: "The dice roll is hard to read on a small screen.",
      session_context: { current_url: `${STANDALONE}/docs/?support` },
    });
  } finally {
    await context.close();
  }
});

test("the Support link opens the composer on desktop", async ({ page }) => {
  await mockSupport(page.context());
  await page.goto(`${STANDALONE}/docs/?support`);
  const input = await composer(page);
  await input.fill("Could I pin the board my group plays on every week?");
  await reviewShot(page, "support-desktop-ticket");
});
