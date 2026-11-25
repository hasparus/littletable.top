import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { joinAs } from "./helpers";

test("an owner on a phone draws an illustrated card that guests can see after rejoining", async ({
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
    await expect(guest.getByRole("menuitem", { name: "Tarot deck" })).toHaveCount(0);
    await guest.keyboard.press("Escape");

    await page.getByTestId("main-menu.button").click();
    await page.getByRole("menuitem", { name: "Tarot deck" }).click();
    const deck = page.getByRole("dialog", { name: "Tarot deck" });
    await expect(deck).toBeInViewport({ ratio: 1 });
    await deck.getByRole("button", { name: "Draw a card" }).click();
    await expect(deck.locator("figcaption")).toBeVisible();
    await deck.getByRole("button", { name: "Close" }).click();
    await expect(deck).toBeHidden();

    const ownerCard = page.getByTestId("canvas").getByRole("img");
    await expect(ownerCard).toBeInViewport({ ratio: 1 });
    const name = (await ownerCard.getAttribute("alt"))!;
    expect(name.length).toBeGreaterThan(0);
    const guestCard = guest.getByTestId("canvas").getByRole("img", { name });
    await expect(guestCard).toBeVisible();
    await expect(guestCard).toHaveAttribute("src", /\/tarot\/rws-1909\/.+\.webp$/u);
    await expect
      .poll(() => guestCard.evaluate((image: HTMLImageElement) => image.naturalHeight))
      .toBe(640);

    await guest.reload();
    await expect(guestCard).toBeVisible();
  } finally {
    await guestContext.close();
  }
});
