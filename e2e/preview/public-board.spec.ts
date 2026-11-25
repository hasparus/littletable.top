import { errors, expect, test } from "@playwright/test";

test("the public board stays usable when left idle", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator(".tl-canvas");
  const menu = page.getByTestId("main-menu.button");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(menu).toBeVisible();

  // WARNING: tldraw can mount successfully and then gate the editor after five seconds.
  await expect(
    canvas.waitFor({ state: "hidden", timeout: 8000 }),
    "canvas stays mounted",
  ).rejects.toThrow(errors.TimeoutError);
  await expect(page.getByTestId("tl-license-expired"), "preview license gate").toHaveCount(0);
  await expect(canvas).toBeVisible();
  await menu.click();
  await expect(page.getByRole("menu")).toBeVisible();
});
