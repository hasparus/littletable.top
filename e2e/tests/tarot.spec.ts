import { expect, test, type Page, type Route } from "@playwright/test";

import { STANDALONE } from "../ports";
import { joinAs } from "./helpers";

async function openGallery(page: Page) {
  await page.getByTestId("main-menu.button").click();
  await expect(page.getByRole("menuitem", { name: "Tarot deck" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Gizmos", exact: true }).click();
  return page.getByRole("dialog", { name: "Gizmo gallery" });
}

test("an owner places physical Gizmos and deals an illustrated card that guests can see after rejoining", async ({
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

    await page.emulateMedia({ reducedMotion: "no-preference" });
    const gate = Promise.withResolvers<Route>();
    await page.route("**/rooms/*/deck", (route) => gate.resolve(route), { times: 1 });
    const top = await stack.getByRole("button", { name: "Draw a card" }).boundingBox();
    await page.mouse.move(top!.x + top!.width / 2, top!.y + top!.height / 2);
    await page.mouse.down();
    const paper = page.locator("[data-deck-paper]");
    await expect
      .poll(() =>
        paper.evaluate((el) =>
          Math.abs(new DOMMatrixReadOnly(getComputedStyle(el.parentElement!).transform).b),
        ),
      )
      .toBeGreaterThan(0.02);
    await page.mouse.move(239, 310, { steps: 8 });
    await page.mouse.up();
    const draw = await gate.promise;
    try {
      await expect
        .poll(() =>
          paper.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m11),
        )
        .toBeLessThan(0.7);
      await expect(page.locator("[data-deck-card]")).toHaveCount(0);
    } finally {
      await draw.continue();
    }
    const card = page.locator("[data-deck-card] img").first();
    await expect(card).toBeInViewport({ ratio: 0.9 });
    const name = await card.getAttribute("alt");
    expect(name).toBeTruthy();
    const guestCard = guest.getByTestId("canvas").getByRole("img", { name: name!, exact: true });
    await expect(guestCard).toBeVisible();
    await expect
      .poll(() => guestCard.evaluate((img: HTMLImageElement) => img.naturalHeight))
      .toBe(640);
    await guest.reload();
    await expect(guestCard).toBeVisible();
    await expect(guest.locator("[data-deck-stack]")).toBeVisible();

    const queue = Promise.withResolvers<Route>();
    await page.route("**/rooms/*/deck", (route) => queue.resolve(route), { times: 1 });
    const tap = stack.locator("[data-deck-draw]");
    await tap.click();
    const firstTap = await queue.promise;
    try {
      await tap.dblclick();
      await expect(stack.locator("[data-deck-base]")).toHaveText("77");
    } finally {
      await firstTap.continue();
    }
    await expect(stack.locator("[data-deck-base]")).toHaveText("74");
    await expect(guest.locator("[data-deck-card]")).toHaveCount(4);

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

test("a card keeps its grip through a deal and can be slid back onto the stack", async ({
  page,
}) => {
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
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up();
  await expect(dealt).toHaveCount(0);
  await expect(count).toHaveText("78");

  await page.mouse.down();
  await page.mouse.move(x + 130, y - 74, { steps: 7 });
  await page.mouse.up();
  await expect(dealt).toHaveCount(1);
  const landed = (await dealt.boundingBox())!;
  expect(Math.abs(landed.x + landed.width / 2 - held.x - held.width / 2)).toBeLessThan(2);
  expect(Math.abs(landed.y - held.y)).toBeLessThan(2);

  await top.press("Enter");
  await top.press("Enter");
  await expect(count).toHaveText("75");
  const faces = await dealt.evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().toJSON()),
  );
  for (const [index, a] of faces.entries()) {
    for (const b of faces.slice(index + 1))
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(
        true,
      );
  }
});

test("rapid taps fill a three-column Tarot spread in reading order", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(STANDALONE + "/dev/gizmos");
  const top = page.getByRole("button", { name: "Draw a card" });
  const cards = page.locator("[data-deck-card]");
  await top.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
    button.click();
  });
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
