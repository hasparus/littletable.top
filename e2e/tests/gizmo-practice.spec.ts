import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { browseGizmos, joinAs, openGallery } from "./helpers";

for (const viewport of [
  { width: 1190, height: 760 },
  { width: 390, height: 820 },
]) {
  test(`Gizmos work at the practice table without a board at ${viewport.width}px`, async ({
    page,
  }) => {
    const roomRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/(?:api|rooms)\//u.test(path)) roomRequests.push(path);
    });
    const wide = viewport.width > 760;
    await page.emulateMedia({ reducedMotion: wide ? "no-preference" : "reduce" });
    await page.setViewportSize(viewport);
    await page.goto(`${STANDALONE}/dev/gizmos/?lang=en`);

    const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
    await expect(page.getByRole("button", { name: "Gizmos", exact: true })).toHaveAttribute(
      "aria-expanded",
      String(wide),
    );
    const tracker = page.locator("[data-gizmo-tracker]");
    const stack = page.locator("[data-deck-stack]");
    await expect(tracker).toBeInViewport({ ratio: 0.99 });
    await expect(stack).toBeInViewport({ ratio: 0.99 });
    const button = page.getByRole("button", { name: "Explosion button" });
    if (wide) await drawer.getByRole("button", { name: "Close" }).click();
    await expect(button).toBeInViewport({ ratio: 0.99 });
    const burst = page.locator("[data-gizmo-burst]");
    await burst.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    const playback = burst.evaluate(
      (layer) =>
        new Promise<number>((resolve) => {
          const sample = () => {
            const animation = layer.querySelector("img")?.getAnimations()[0];
            if (animation?.effect instanceof KeyframeEffect)
              resolve(animation.effect.getKeyframes().length);
            else requestAnimationFrame(sample);
          };
          sample();
        }),
    );
    await button.press("Space");
    expect(await playback).toBe(wide ? 25 : 2);
    await expect(button).toHaveAttribute("data-hits", "1");
    await expect
      .poll(() =>
        page
          .locator(".tl-canvas")
          .evaluate((canvas) =>
            canvas
              .getAnimations()
              .some((animation) => animation.id === "little-table:gizmo-spring"),
          ),
      )
      .toBe(wide);
    await tracker.getByRole("button", { name: "Mark a moment for Ash" }).click();
    await expect(tracker.getByRole("button").first()).toHaveAccessibleName(
      "Mark a moment for Rowan",
    );
    await stack.getByRole("button", { name: "Draw a card" }).click();
    await expect(page.locator("[data-deck-card]")).toBeVisible();

    await page.getByRole("button", { name: "Gizmos", exact: true }).click();
    await drawer.getByRole("button", { name: "Spotlight tracker" }).press("Enter");
    await expect(tracker).toHaveCount(2);
    await expect(drawer).toBeHidden();
    expect(roomRequests).toEqual([]);
    await page.getByRole("link", { name: "Research notes" }).click();
    await expect(page).toHaveTitle("Gizmos · Little Table research");
  });
}

test("a workshop button without a shake capability keeps the table still", async ({ page }) => {
  await page.route("**/gizmos/explosion/gizmo.json", async (route) => {
    const packageFile = await route.fetch();
    const { effect: _effect, ...manifest } = await packageFile.json();
    await route.fulfill({ json: { ...manifest, name: { en: "Bell", pl: "Dzwonek" } } });
  });
  await page.setViewportSize({ width: 650, height: 690 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${STANDALONE}/dev/gizmos/?lang=en`);
  const bell = page.getByRole("button", { name: "Bell" });
  await bell.click();
  await expect(bell).toHaveAttribute("data-hits", "1");
  expect(await page.locator(".tl-canvas").evaluate((el) => el.getAnimations().length)).toBe(0);
});

test("practice installs a marketplace piece and brings its drawer button into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto(STANDALONE + "/dev/gizmos/?empty&lang=en");
  const market = page.getByRole("dialog", { name: "Gizmo marketplace" });
  for (const name of ["Tarot deck", "Explosion button"]) {
    await market.getByRole("button", { name: "Install " + name }).click();
    await browseGizmos(page);
  }
  const listing = market.getByRole("article", { name: "Spotlight tracker" });
  await expect(listing.getByRole("link", { name: "View code" })).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\//u,
  );
  await listing.getByRole("button", { name: "Install Spotlight tracker" }).click();
  const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
  const placed = drawer.getByRole("button", { name: "Spotlight tracker" });
  await expect(market).toBeHidden();
  await expect(placed).toBeInViewport({ ratio: 0.98 });
  await expect(placed).toBeFocused();
  await expect
    .poll(() =>
      drawer.locator("[data-gizmo-compartment]").evaluate((compartment) => compartment.scrollTop),
    )
    .toBeGreaterThan(0);
  await browseGizmos(page);
  await expect(listing.getByText("Installed", { exact: true })).toBeVisible();
  await market.getByRole("button", { name: "Back", exact: true }).click();
  await placed.press("Enter");
  await expect(drawer).toBeHidden();
  await expect(page.locator("[data-gizmo-tracker]")).toHaveCount(1);
});

test("requests survive the owner's absence, merge across players, and install once approved", async ({
  page,
  browser,
}) => {
  await page.goto(STANDALONE + "/boards");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Marketplace owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { name: "Dice", exact: true })).toBeVisible();
  const board = page.url();
  await page.goto(STANDALONE + "/boards");
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const player = await first.newPage();
    const friend = await second.newPage();
    for (const [tab, name] of [
      [player, "Mira"],
      [friend, "Sam"],
    ] as const) {
      await tab.goto(board);
      await joinAs(tab, name);
      const market = await openGallery(tab, "Gizmo marketplace");
      const listing = market.getByRole("article", { name: "Explosion button" });
      await listing.getByRole("button", { name: "Request Explosion button" }).click();
      await expect(listing.getByText("Requested", { exact: true })).toBeVisible();
    }
    await friend
      .getByRole("dialog", { name: "Gizmo marketplace" })
      .getByRole("button", { name: "Close" })
      .click();
    await player.reload();
    const market = await openGallery(player, "Gizmo marketplace");
    const listing = market.getByRole("article", { name: "Explosion button" });
    await expect(listing.getByText("Requested", { exact: true })).toBeVisible();
    await expect(listing.getByRole("button", { name: "Request Explosion button" })).toHaveCount(0);
    await page.goto(board);
    const inbox = page.getByRole("dialog", { name: "Review Gizmo request" });
    await expect(inbox.getByRole("heading", { name: "Explosion button" })).toBeVisible();
    await expect(inbox).toContainText("Mira");
    await expect(inbox).toContainText("Sam");
    await expect(inbox.getByRole("link")).toHaveAttribute("href", /^https:\/\/github\.com\//u);
    await inbox.getByRole("button", { name: "Install", exact: true }).click();
    await expect(inbox).toBeHidden();
    const installed = page.getByRole("dialog", { name: "Gizmo gallery" });
    await expect(installed.getByRole("button", { name: "Explosion button" })).toBeFocused();
    await installed.getByRole("button", { name: "Close" }).click();
    const drawer = player.getByRole("dialog", { name: "Gizmo gallery" });
    const explosion = drawer.getByRole("button", { name: "Explosion button" });
    await expect(explosion).toBeVisible();
    await expect(friend.getByRole("dialog", { name: "Gizmo gallery" })).toBeHidden();
    await explosion.press("Enter");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: "Explosion button" })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Dice", exact: true })).toBeVisible();
    await expect(inbox).toHaveCount(0);
    const ownerDrawer = await openGallery(page);
    await expect(ownerDrawer.getByRole("button", { name: "Explosion button" })).toHaveCount(1);

    await openGallery(player);
    await browseGizmos(player);
    const folder = "https://github.com/example/gizmos/tree/main/gizmos/spotlight";
    const manifest = "https://github.com/example/gizmos/blob/main/gizmos/spotlight/gizmo.json";
    await market.getByRole("textbox", { name: /GitHub/ }).fill(folder);
    await market.getByRole("button", { name: "Request", exact: true }).click();
    const custom = market.locator("[data-gizmo-custom-status]");
    await expect(custom.getByRole("link")).toHaveAttribute("href", manifest);
    await expect(custom.getByText("Requested", { exact: true })).toBeVisible();
    await expect(inbox.getByRole("heading", { name: "spotlight", exact: true })).toBeVisible();
    await expect(inbox).toContainText("example/gizmos");
    await expect(inbox).toContainText("main/gizmos/spotlight/gizmo.json");
    await expect(inbox.getByRole("link", { name: "View code" })).toHaveAttribute("href", manifest);
    await inbox.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(inbox).toBeHidden();
    await expect(custom.getByText("Declined", { exact: true })).toBeVisible();
    await player.reload();
    await openGallery(player);
    await browseGizmos(player);
    await expect(custom.getByText("Declined", { exact: true })).toBeVisible();
    await expect(ownerDrawer.getByRole("button", { name: "Spotlight tracker" })).toHaveCount(0);
  } finally {
    await first.close();
    await second.close();
  }
});
