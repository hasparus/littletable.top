import { expect, test, type Page } from "@playwright/test";

import { deckPrepared } from "../../src/deck-records";
import { STANDALONE } from "../ports";
import { joinAs } from "./helpers";

async function tapCard(page: Page, x: number, y: number, times = 1) {
  const finger = await page.context().newCDPSession(page);
  try {
    for (let tap = 0; tap < times; tap++) {
      await finger.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } finally {
    await finger.detach();
  }
}

async function openGallery(page: Page) {
  await page.getByTestId("main-menu.button").click();
  await expect(page.getByRole("menuitem", { name: "Tarot deck" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Gizmos", exact: true }).click();
  return page.getByRole("dialog", { name: "Gizmo gallery" });
}

test("a loose face-down card survives rejoining and reveals the face prepared at pickup", async ({
  browser,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ height: 760, width: 360 });
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Deck owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.emulateMedia({ reducedMotion: "reduce" });
  try {
    await guest.goto(page.url());
    await joinAs(guest, "Card player");
    await guest.getByTestId("main-menu.button").click();
    await expect(guest.getByRole("menuitem", { name: "Gizmos" })).toHaveCount(0);
    await guest.keyboard.press("Escape");

    await page.mouse.move(180, 255);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    const gallery = await openGallery(page);
    await expect(gallery).toBeInViewport({ ratio: 1 });
    await expect(gallery.getByText("Install your first Gizmo from GitHub.")).toBeVisible();
    const source = gallery.getByRole("textbox", { name: /GitHub/ });
    const upstream = "https://github.com/example/gizmos/blob/" + "a".repeat(40);
    for (const [name, folder] of [
      ["Tarot deck", "tarot"],
      ["Spotlight tracker", "spotlight"],
    ]) {
      await source.fill(upstream + "/gizmos/" + folder + "/gizmo.json");
      await gallery.getByRole("button", { name: "Install", exact: true }).click();
      await expect(gallery.getByRole("button", { name, exact: true })).toBeVisible();
    }
    const sounds = gallery.getByRole("button", { name: "Gizmo sounds" });
    await sounds.click();
    await expect(sounds).toHaveAttribute("aria-pressed", "false");
    const miniature = gallery.getByRole("button", { name: "Tarot deck" });
    const origin = await miniature.boundingBox();
    expect(origin).not.toBeNull();
    const finger = await page.context().newCDPSession(page);
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: origin!.x + origin!.width / 2, y: origin!.y + 48 }],
    });
    await finger.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 105, y: 234 }],
    });
    await expect(page.locator("[data-gizmo-carry]")).toBeVisible();
    await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await finger.detach();
    await expect(gallery).toBeHidden();
    const stack = page.locator("[data-deck-stack]");
    await expect(stack).toBeVisible();
    const bounds = await stack.boundingBox();
    expect(Math.abs(bounds!.x + bounds!.width / 2 - 105)).toBeLessThan(6);
    expect(Math.abs(bounds!.y + bounds!.height / 2 - 234)).toBeLessThan(6);
    await expect(guest.locator("[data-deck-stack]")).toBeVisible();
    await expect(guest.getByRole("button", { name: "Draw a card" })).toHaveCount(0);

    const top = (await stack.getByRole("button", { name: "Draw a card" }).boundingBox())!;
    const center = { x: top.x + top.width / 2, y: top.y + top.height / 2 };
    const prepared = page.waitForResponse(
      (response) =>
        response.url().endsWith("/deck") &&
        response.request().method() === "POST" &&
        response.request().postDataJSON().action === "prepare",
    );
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    const pickup = await prepared;
    expect(pickup.ok()).toBe(true);
    const { face } = deckPrepared.validate(await pickup.json());
    await expect(stack.locator("[data-deck-base]")).toHaveText("78");
    await page.mouse.move(center.x + top.width * 0.35, center.y, { steps: 6 });
    await page.mouse.up();

    const loose = page.locator("[data-deck-down]");
    const guestBack = guest.locator("[data-deck-down]");
    await expect(loose).toHaveCount(1);
    await expect(guestBack).toBeVisible();
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");
    await guest.reload();
    await expect(guestBack).toBeVisible();
    await expect(guest.locator("[data-deck-front]")).toHaveCount(0);
    await page.reload();
    await expect(loose).toBeVisible();
    const before = (await loose.boundingBox())!;
    const cx = before.x + before.width / 2;
    const cy = before.y + before.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 85, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const landed = await loose.boundingBox();
        return landed?.x;
      })
      .toBeCloseTo(before.x + 100, 0);
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");
    await expect(guestBack).toBeVisible();
    await guestBack.getByRole("button", { name: "Turn card over" }).click();
    const guestFace = guest.locator("[data-deck-front] img");
    await expect(guestFace).toHaveCount(1);
    await expect(guestFace).toHaveJSProperty("src", new URL(face, page.url()).href);
    await expect
      .poll(() => guestFace.evaluate((img: HTMLImageElement) => img.naturalHeight))
      .toBe(640);
    await expect(guestBack).toHaveCount(0);
    await expect(page.locator("[data-deck-front] img")).toHaveJSProperty(
      "src",
      new URL(face, page.url()).href,
    );
    await expect(stack.locator("[data-deck-base]")).toHaveText("77");

    await openGallery(page);
    await gallery.getByRole("button", { name: "Spotlight tracker" }).focus();
    await page.keyboard.press("Enter");
    await expect(gallery).toBeHidden();
    const next = page.locator("[data-tracker-seat]").first();
    await expect(next).toHaveAccessibleName("Mark a moment for Deck owner");
    await guest.getByRole("button", { name: "Mark a moment for Deck owner" }).click();
    await expect(next).toHaveAccessibleName("Mark a moment for Card player");
  } finally {
    await guestContext.close();
  }
});

test("a drag can be cancelled or dropped face down at its release point", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const top = page.getByRole("button", { name: "Draw a card" });
  const dealt = page.locator("[data-deck-card]");
  const count = page.locator("[data-deck-base]");
  await expect(count).toHaveText("78");
  const rect = (await top.boundingBox())!;
  const x = rect.x + 9,
    y = rect.y + 16;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 130, y - 74, { steps: 7 });
  const held = (await page.locator("[data-deck-ghost]").boundingBox())!;
  expect(Math.abs(held.x - rect.x - 130)).toBeLessThan(2);
  expect(Math.abs(held.y - rect.y + 74)).toBeLessThan(2);
  expect(Math.abs(held.width - rect.width)).toBeLessThan(2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(dealt).toHaveCount(0);
  await expect(count).toHaveText("78");

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 130, y - 74, { steps: 7 });
  const offset = rect.width * 0.35;
  await page.mouse.move(x + offset, y, { steps: 5 });
  await page.mouse.up();
  const down = page.locator("[data-deck-down]");
  await expect(down).toBeVisible();
  const near = (await down.boundingBox())!;
  expect(Math.abs(near.x - rect.x - offset)).toBeLessThan(2);
  expect(Math.abs(near.y - rect.y)).toBeLessThan(2);
  await expect(count).toHaveText("77");
  await expect(page.locator("[data-deck-front]")).toHaveCount(0);
  await tapCard(page, near.x + near.width / 2, near.y + near.height / 2);
  const face = page.locator("[data-deck-front] img");
  await expect(face).toBeVisible();
  await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(640);
  await expect(down).toHaveCount(0);
  await expect(count).toHaveText("77");
});

test("rapid taps fill a three-column Tarot spread in reading order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  const top = page.getByRole("button", { name: "Draw a card" });
  const cards = page.locator("[data-deck-card]");
  const rect = (await top.boundingBox())!;
  await tapCard(page, rect.x + rect.width / 2, rect.y + rect.height / 2, 3);
  await expect(cards).toHaveCount(3);
  const centers = await cards.evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })
      .sort((a, b) => a.x - b.x),
  );
  expect(Math.abs(centers[2]!.y - centers[0]!.y)).toBeLessThan(1);
  expect(Math.abs(centers[2]!.x - 2 * centers[1]!.x + centers[0]!.x)).toBeLessThan(1);
  expect(centers[1]!.x - centers[0]!.x).toBeGreaterThan(70);
  for (const card of await cards.all()) await expect(card).toBeInViewport({ ratio: 0.99 });
  await top.click();
  await expect(cards).toHaveCount(4);
  await expect(page.locator("[data-deck-base]")).toHaveText("74");
});

test("a far drop keeps one back in place until its prepared face is ready", async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 720 });
  await page.goto(STANDALONE + "/dev/gizmos");
  const top = page.locator("[data-deck-draw]");
  await expect(top).toBeVisible();
  const allowArt = Promise.withResolvers<boolean>();
  const faceArt = /\/gizmos\/tarot\/art\/(?!back\.webp)[^/]+\.webp$/;
  await page.route(faceArt, async (route) => {
    await allowArt.promise;
    await route.continue();
  });
  const rect = (await top.boundingBox())!;
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const requested = page.waitForRequest(faceArt);
  const card = page.locator("[data-deck-card]");
  const front = card.locator("[data-deck-front]");
  let expectedFace: string;
  try {
    await page.mouse.move(x, y);
    await page.mouse.down();
    const request = await requested;
    expectedFace = request.url();
    await expect(page.locator("[data-deck-base]")).toHaveText("78");
    await page.mouse.move(x + rect.width * 1.8, y + 35, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("[data-deck-card][data-deck-waiting]")).toHaveCount(1);
    await expect(card.locator("[data-deck-turn]")).toBeVisible();
    await expect(front).toBeHidden();
    await expect(page.locator("[data-deck-ghost], [data-deck-down]")).toHaveCount(0);
  } finally {
    allowArt.resolve(true);
  }
  await expect(front).toBeVisible();
  await expect(card).toHaveCount(1);
  const face = front.locator("img");
  await expect(face).toHaveJSProperty("src", expectedFace);
  await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(640);
  await expect(page.locator("[data-deck-base]")).toHaveText("77");
});
