import { expect, test, type Locator, type Page } from "@playwright/test";

import { STANDALONE } from "../ports";
import { browseGizmos, joinAs, openGallery } from "./helpers";

async function dragByTouch(page: Page, handle: Locator, target: Locator) {
  const start = (await handle.boundingBox())!;
  const end = (await target.boundingBox())!;
  const finger = await page.context().newCDPSession(page);
  try {
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }],
    });
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: end.x + end.width / 2, y: end.y + end.height / 2 }],
    });
    await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await finger.detach();
  }
}

async function installPracticePiece(page: Page, name: string) {
  await page.goto(STANDALONE + "/dev/gizmos/?empty&lang=en");
  const market = page.getByRole("dialog", { name: "Gizmo marketplace" });
  await market.getByRole("button", { name: "Install " + name, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
  await drawer.getByRole("button", { name, exact: true }).press("Enter");
  await expect(drawer).toBeHidden();
}

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
    const tracker = page.locator("[data-spotlight-rail]");
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
    const marker = tracker.getByRole("button", { name: "Move spotlight marker" });
    await expect(tracker.getByRole("button", { name: "Spotlight Ash" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await marker.press("ArrowDown");
    await expect(tracker.getByRole("button", { name: "Spotlight Rowan" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await stack.getByRole("button", { name: "Draw a card" }).click();
    await expect(page.locator("[data-deck-card]")).toBeVisible();

    await page.getByRole("button", { name: "Gizmos", exact: true }).click();
    await drawer.getByRole("button", { name: "Spotlight rail" }).press("Enter");
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
  const listing = market.getByRole("article", { name: "Spotlight rail" });
  await expect(listing.getByRole("link", { name: "View code" })).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\//u,
  );
  await listing.getByRole("button", { name: "Install Spotlight rail" }).click();
  const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
  const placed = drawer.getByRole("button", { name: "Spotlight rail" });
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
  const rail = page.locator("[data-spotlight-rail]");
  const names = rail.getByRole("textbox", { name: "Participant name" });
  await expect(names).toHaveCount(2);
  await names.nth(1).fill("Nia");
  await names.nth(1).press("Enter");
  await expect(rail.getByRole("button", { name: "Spotlight Ash" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dragByTouch(
    page,
    rail.getByRole("button", { name: "Move spotlight marker" }),
    names.nth(1),
  );
  await expect(rail.getByRole("button", { name: "Spotlight Nia" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rail.getByRole("button", { name: "Spotlight Ash" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const grip = rail.getByRole("button", { name: "Reorder Nia" });
  await dragByTouch(page, grip, names.first());
  await expect(names.first()).toHaveValue("Nia");
  await expect(rail.getByRole("button", { name: "Spotlight Nia" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await grip.press("ArrowDown");
  await expect(names.last()).toHaveValue("Nia");
});

test("each Spotlight slider keeps its own level and participant name", async ({ page }) => {
  await installPracticePiece(page, "Spotlight sliders");
  const sliders = page.locator("[data-spotlight-sliders]");
  const ash = sliders.getByRole("slider", { name: "Level for Ash" });
  const rowan = sliders.getByRole("slider", { name: "Level for Rowan" });
  await expect(ash).toHaveAttribute("min", "0");
  await expect(ash).toHaveAttribute("max", "100");
  await expect(rowan).toHaveValue("0");
  const first = (await ash.boundingBox())!;
  const second = (await rowan.boundingBox())!;
  expect(first.width).toBeGreaterThan(first.height);
  expect(second.y).toBeGreaterThan(first.y + first.height);
  await ash.press("End");
  await expect(ash).toHaveValue("100");
  await ash.press("ArrowDown");
  await expect(ash).toHaveValue("90");
  await expect(rowan).toHaveValue("0");
  await rowan.press("ArrowUp");
  const participant = sliders.getByRole("textbox", { name: "Participant name" }).nth(1);
  await participant.fill("Nia");
  await participant.press("Enter");
  const renamed = sliders.getByRole("slider", { name: "Level for Nia" });
  await expect(renamed).toHaveValue("10");
  await renamed.press("Home");
  await expect(renamed).toHaveValue("0");
  await expect(ash).toHaveValue("90");
});

test("reordering initiative portraits preserves the active character and changes the next turn", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await installPracticePiece(page, "Initiative tracker");
  const initiative = page.locator("[data-initiative-rail]");
  const ash = initiative.getByRole("button", { name: "Turn for Ash" });
  const rowan = initiative.getByRole("button", { name: "Turn for Rowan" });
  await expect(ash).toHaveAttribute("aria-current", "true");
  await initiative.getByRole("button", { name: "Add character" }).click();
  const third = initiative.getByRole("button", { name: "Turn for Character 3" });
  await expect(third).toBeVisible();
  await dragByTouch(page, ash, rowan);
  const portraits = initiative.locator("[data-portrait]");
  await expect(portraits.nth(0)).toHaveAccessibleName("Turn for Rowan");
  await expect(portraits.nth(1)).toHaveAccessibleName("Turn for Ash");
  await expect(ash).toHaveAttribute("aria-current", "true");
  const advance = initiative.getByRole("button", { name: "Next turn" });
  await advance.click();
  await expect(third).toHaveAttribute("aria-current", "true");
  await advance.click();
  await expect(rowan).toHaveAttribute("aria-current", "true");
});

test("a participant can reorder shared initiative and the next turn survives a reload", async ({
  page,
  browser,
}) => {
  await page.goto(STANDALONE + "/boards");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Mira");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { name: "Dice", exact: true })).toBeVisible();
  const board = page.url();
  const market = await openGallery(page, "Gizmo marketplace");
  const installing = page.waitForResponse(
    (reply) =>
      reply.request().method() === "POST" &&
      /\/rooms\/[\w-]+\/gizmos$/u.test(new URL(reply.url()).pathname),
  );
  await market.getByRole("button", { name: "Install Initiative tracker" }).click();
  const installed = await installing;
  expect(installed.ok()).toBe(true);
  const room = new URL(installed.url()).pathname.replace(/\/gizmos$/u, "");
  const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
  await drawer.getByRole("button", { name: "Initiative tracker" }).press("Enter");
  const initiative = page.locator("[data-initiative-rail]");
  await expect(initiative.getByRole("button", { name: "Turn for Mira" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await initiative.getByRole("button", { name: "Add character" }).click();

  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(board);
    await joinAs(guest, "Robin");
    const guestRail = guest.locator("[data-initiative-rail]");
    await expect(guestRail.getByRole("button", { name: "Turn for Character 2" })).toBeVisible();
    await guestRail.getByRole("button", { name: "Turn for Mira" }).press("ArrowRight");

    async function expectSharedLine(current: string) {
      for (const rail of [initiative, guestRail]) {
        const portraits = rail.locator("[data-portrait]");
        await expect(portraits).toHaveCount(2);
        await expect(portraits.nth(0)).toHaveAccessibleName("Turn for Character 2");
        await expect(portraits.nth(1)).toHaveAccessibleName("Turn for Mira");
        await expect(rail.locator('[data-portrait][aria-current="true"]')).toHaveAccessibleName(
          "Turn for " + current,
        );
      }
    }

    await expectSharedLine("Mira");
    await guestRail.getByRole("button", { name: "Next turn" }).click();
    await expectSharedLine("Character 2");
    await Promise.all([page.reload(), guest.reload()]);
    await expectSharedLine("Character 2");
    for (const rail of [initiative, guestRail]) {
      const images = rail.locator("[data-portrait] img");
      await expect(images).toHaveCount(2);
      for (const [index, file] of ["pentacles-14", "cups-11"].entries()) {
        const image = images.nth(index);
        await expect(image).toHaveAttribute(
          "src",
          new RegExp(`^${room}/gizmo-assets/[a-f0-9]{64}/${file}\\.webp$`, "u"),
        );
        expect(
          await image.evaluate(async (img: HTMLImageElement) => {
            await img.decode();
            return img.naturalWidth * img.naturalHeight;
          }),
        ).toBeGreaterThan(0);
      }
    }
  } finally {
    await context.close();
  }
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
