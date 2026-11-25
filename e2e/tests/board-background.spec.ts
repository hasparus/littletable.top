import type { Editor } from "tldraw";

import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { joinAs, phone, putNote, reachEditor, reviewShot } from "./helpers";
import { downloadTldr } from "./tldr";

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
  await expect(canvasBackground(page)).toHaveCSS("background-color", "rgb(235, 237, 231)");
  await expect(canvasBackground(guest)).toHaveCSS("background-color", "rgb(235, 237, 231)");
  await guest.emulateMedia({ colorScheme: "dark" });
  await expect(canvasBackground(guest)).toHaveCSS("background-color", "rgb(44, 47, 42)");
  await reviewShot(page, "board-background-sage");

  await page.reload();
  await expect(canvasBackground(page)).toHaveAttribute("data-board-background", "sage");
  await menu.click();
  await page.getByRole("menuitem", { name: "Background color" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Default" }).click();
  await expect(canvasBackground(guest)).toHaveAttribute("data-board-background", "default");
  await guest.context().close();
});

test("board color survives a file copy and appears in opaque SVG exports", async ({ page }) => {
  await page.goto(`${STANDALONE}/boards?lang=en`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  const newBoard = page.getByRole("button", { name: "New board" });
  await newBoard.click();
  const menu = page.getByTestId("main-menu.button");
  const chooseColor = async (name: string) => {
    await menu.click();
    await page.getByRole("menuitem", { name: "Background color" }).hover();
    await page.getByRole("menuitemcheckbox", { name }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  };
  await chooseColor("Sage");
  await putNote(page, { at: { x: 400, y: 350 }, text: "Map notes" });
  await reachEditor(page);
  const backgrounds = await page.evaluate(async () => {
    const { __editor: editor } = globalThis as unknown as { __editor: Editor };
    const shapes = [...editor.getCurrentPageShapeIds()];
    const results = await Promise.all([
      editor.getSvgString(shapes, { background: true, darkMode: false }),
      editor.getSvgString(shapes, { background: false, darkMode: false }),
    ]);
    return results.map((result) => {
      if (result === undefined) return null;
      const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
      return svg.querySelector("svg")?.style.backgroundColor;
    });
  });
  expect(backgrounds).toEqual(["rgb(235, 237, 231)", "transparent"]);

  const json = await downloadTldr(page);
  await page.goto(`${STANDALONE}/boards`);
  await newBoard.click();
  const importBoard = async () => {
    const chooser = page.waitForEvent("filechooser");
    await menu.click();
    await page.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
    const picker = await chooser;
    await picker.setFiles({
      buffer: Buffer.from(json),
      mimeType: "application/vnd.tldraw+json",
      name: "background.tldr",
    });
  };
  const background = page.locator("[data-board-background]:visible");
  await importBoard();
  await expect(background).toHaveAttribute("data-board-background", "sage");
  await chooseColor("Default");
  await importBoard();
  await expect(
    page.getByText("The file's pages were added to the board.", { exact: true }),
  ).toBeVisible();
  await expect(background).toHaveAttribute("data-board-background", "default");
});
