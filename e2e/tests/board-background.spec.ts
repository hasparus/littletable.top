import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { joinAs, phone, reviewShot } from "./helpers";

test("board background follows collaborators and survives a reload", async ({ browser, page }) => {
  await page.goto(`${STANDALONE}/boards?lang=en`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  const menu = page.getByTestId("main-menu.button");
  await expect(menu).toBeVisible();

  const guest = await phone(browser, page.url());
  await joinAs(guest, "Sam");
  const canvasBackground = (client: typeof page) =>
    client.locator("[data-board-background]:visible");
  await expect(canvasBackground(guest)).toHaveAttribute("data-board-background", "default");

  await menu.click();
  await page.getByRole("menuitem", { name: "Background color" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Sage" }).click();
  await expect(canvasBackground(page)).toHaveCSS("background-color", "rgb(232, 240, 227)");
  await expect(canvasBackground(guest)).toHaveCSS("background-color", "rgb(232, 240, 227)");
  await reviewShot(page, "board-background-sage");

  await page.reload();
  await expect(canvasBackground(page)).toHaveAttribute("data-board-background", "sage");
  await menu.click();
  await page.getByRole("menuitem", { name: "Background color" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Default" }).click();
  await expect(canvasBackground(guest)).toHaveAttribute("data-board-background", "default");
  await guest.context().close();
});
