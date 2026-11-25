import { expect, test, type Page } from "@playwright/test";

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

    const top = await stack.getByRole("button", { name: "Draw a card" }).boundingBox();
    await page.mouse.move(top!.x + top!.width / 2, top!.y + top!.height / 2);
    await page.mouse.down();
    await page.mouse.move(239, 310, { steps: 8 });
    await page.mouse.up();
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
