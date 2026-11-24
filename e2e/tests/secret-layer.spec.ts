import type { Editor } from "tldraw";

import { expect, test } from "@playwright/test";

import { boardAt, STANDALONE } from "../ports";
import { joinAs, onBoard, phone, putNote, reachEditor } from "./helpers";

test.use({ colorScheme: "dark" });

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
  const canUndo = async () => {
    await reachEditor(owner);
    return owner.evaluate(() => (globalThis as unknown as { __editor: Editor }).__editor.canUndo());
  };
  expect(await canUndo()).toBe(true);
  const sharedPosition = await onBoard(owner, sharedText).boundingBox();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(owner.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const backdropText = onBoard(owner, sharedText).filter({ visible: true });
  await expect(backdropText).toBeVisible();
  await expect.poll(() => backdropText.boundingBox()).toEqual(sharedPosition);
  await expect(owner.locator("[inert] .tl-theme__dark").first()).toBeVisible();
  await putNote(owner, { at: { x: 110, y: 380 }, text: privateText });
  await expect(onBoard(owner, privateText)).toBeVisible();
  await expect(onBoard(guest, privateText)).toHaveCount(0);

  const secondTab = await owner.context().newPage();
  await secondTab.goto(owner.url());
  await secondTab.getByRole("button", { name: "Secret layer" }).click();
  await expect(onBoard(secondTab, privateText)).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(canUndo).toBe(true);
  await expect(onBoard(owner, sharedText)).toBeVisible();
  await expect(onBoard(owner, privateText)).not.toBeVisible();
  await guest.reload();
  await expect(onBoard(guest, sharedText)).toBeVisible();
  await expect(onBoard(guest, privateText)).toHaveCount(0);
  await secondTab.close();
  await guest.context().close();

  await toggle.click();
  await expect(onBoard(owner, privateText)).toBeVisible();
  await reachEditor(owner);
  await owner.evaluate(() => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    for (let index = editor.getPages().length; index < editor.options.maxPages; index++) {
      editor.createPage({ name: `Private page ${index}` });
    }
  });
  await toggle.click();
  await reachEditor(owner);
  await owner.evaluate(() => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    const name = "Unmapped shared page";
    editor.createPage({ name });
    editor.setCurrentPage(editor.getPages().find((page) => page.name === name)!.id);
  });
  await toggle.click();
  await expect(owner.getByText("The secret layer has reached its page limit.")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await owner.getByRole("button", { name: "Open private pages" }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});
