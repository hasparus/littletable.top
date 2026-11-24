import { expect, test } from "@playwright/test";

import { boardAt, STANDALONE } from "../ports";
import { joinAs, onBoard, phone, putNote } from "./helpers";

test("the owner can write over the shared board without sharing the note", async ({
  browser,
  page: owner,
}) => {
  await owner.goto(`${STANDALONE}/`);
  await owner.getByRole("link", { name: "Sign in" }).click();
  await owner.getByLabel("Name").fill("Game master");
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.getByRole("button", { name: "New board" }).click();
  await expect(owner).toHaveURL(boardAt(STANDALONE));
  await expect(owner.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const guest = await phone(browser, owner.url());
  await joinAs(guest, "Guest");
  const toggle = owner.getByRole("button", { name: "Secret layer" });
  await expect(guest.getByRole("button", { name: "Secret layer" })).toHaveCount(0);
  const sharedText = "The road lies ahead";
  const privateText = "An ambush just past the bridge";
  await putNote(owner, { at: { x: 110, y: 230 }, text: sharedText });
  await expect(onBoard(guest, sharedText)).toBeVisible();
  const sharedPosition = await onBoard(owner, sharedText).boundingBox();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(owner.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expect(onBoard(owner, sharedText)).toBeVisible();
  await expect.poll(() => onBoard(owner, sharedText).boundingBox()).toEqual(sharedPosition);
  await putNote(owner, { at: { x: 110, y: 380 }, text: privateText });
  await expect(onBoard(owner, privateText)).toBeVisible();
  await expect(onBoard(guest, privateText)).toHaveCount(0);

  const secondTab = await owner.context().newPage();
  await secondTab.goto(owner.url());
  await secondTab.getByRole("button", { name: "Secret layer" }).click();
  await expect(onBoard(secondTab, privateText)).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(onBoard(owner, sharedText)).toBeVisible();
  await expect(onBoard(owner, privateText)).toHaveCount(0);
  await guest.reload();
  await expect(onBoard(guest, sharedText)).toBeVisible();
  await expect(onBoard(guest, privateText)).toHaveCount(0);
  await secondTab.close();
  await guest.context().close();
});
