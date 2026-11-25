import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { STANDALONE } from "../ports";
import { putNote } from "./helpers";

test("Share exports and publishes the shared page while the secret layer is active", async ({
  context,
  page,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Board owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();

  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const share = page.getByRole("button", { exact: true, name: "Share" });
  await putNote(page, { at: { x: 200, y: 220 }, text: "The shared map" });
  await share.click();
  await page.getByRole("button", { name: "Copy board link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export page as PNG" }).click();
  const file = await downloaded;
  const exported = await readFile((await file.path())!);
  await page.keyboard.press("Escape");

  const toggle = page.getByRole("button", { name: "Secret layer" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await putNote(page, { at: { x: 400, y: 430 }, text: "The hidden passage" });
  await share.click();
  await page.getByRole("button", { name: "Publish shared page" }).click();
  await page.getByRole("button", { name: "Copy published link" }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  const publicPage = await request.get(url);
  expect(publicPage.headers()["content-type"]).toContain("image/png");
  expect(await publicPage.body()).toEqual(exported);

  await page.keyboard.press("Escape");
  await page.getByTestId("page-menu.button").click();
  await page.getByTestId("page-menu.create").click();
  const name = page.getByTestId("page-menu.list").getByRole("textbox");
  await name.fill("Private preparations");
  await name.press("Enter");
  await page.keyboard.press("Escape");
  await share.click();
  await expect(page.getByRole("button", { name: "Export page as PNG" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Update published page" })).toBeDisabled();
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(
    page.getByRole("status", { name: "" }).filter({ hasText: "Page unpublished." }),
  ).toBeVisible();
  const withdrawn = await request.get(url);
  expect(withdrawn.status()).toBe(404);
});
