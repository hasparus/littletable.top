import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";

for (const viewport of [
  { width: 1190, height: 760 },
  { width: 390, height: 820 },
]) {
  test(`Gizmos work at the practice table without a board at ${viewport.width}px`, async ({
    page,
  }) => {
    const roomRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/(?:api|rooms)\//u.test(path)) roomRequests.push(path);
    });
    const wide = viewport.width > 760;
    await page.emulateMedia({ reducedMotion: wide ? "no-preference" : "reduce" });
    await page.setViewportSize(viewport);
    await page.goto(`${STANDALONE}/dev/gizmos/?lang=en`);

    const drawer = page.getByRole("dialog", { name: "Gizmo gallery" });
    await expect(page.getByRole("button", { name: "Gizmos", exact: true })).toHaveAttribute(
      "aria-expanded",
      String(wide),
    );
    const tracker = page.locator("[data-gizmo-tracker]");
    const stack = page.locator("[data-deck-stack]");
    await expect(tracker).toBeInViewport({ ratio: 0.99 });
    await expect(stack).toBeInViewport({ ratio: 0.99 });
    const button = page.getByRole("button", { name: "Explosion button" });
    if (wide) await drawer.getByRole("button", { name: "Close" }).click();
    await expect(button).toBeInViewport({ ratio: 0.99 });
    await button.press("Space");
    await expect(button).toHaveAttribute("data-hits", "1");
    await expect
      .poll(() =>
        page
          .locator(".tl-canvas")
          .evaluate((canvas) =>
            canvas
              .getAnimations()
              .some((animation) => animation.id === "little-table:gizmo-spring"),
          ),
      )
      .toBe(wide);
    await tracker.getByRole("button", { name: "Mark a moment for Ash" }).click();
    await expect(tracker.getByRole("button").first()).toHaveAccessibleName(
      "Mark a moment for Rowan",
    );
    await stack.getByRole("button", { name: "Draw a card" }).click();
    await expect(page.locator("[data-deck-card]")).toBeVisible();

    await page.getByRole("button", { name: "Gizmos", exact: true }).click();
    await drawer.getByRole("button", { name: "Spotlight tracker" }).press("Enter");
    await expect(tracker).toHaveCount(2);
    await expect(drawer).toBeHidden();
    expect(roomRequests).toEqual([]);
    await page.getByRole("link", { name: "Research notes" }).click();
    await expect(page).toHaveTitle("Gizmos · Little Table research");
  });
}

test("a workshop button without a shake capability keeps the table still", async ({ page }) => {
  await page.route("**/gizmos/explosion/gizmo.json", async (route) => {
    const packageFile = await route.fetch();
    const { effect: _effect, ...manifest } = await packageFile.json();
    await route.fulfill({ json: { ...manifest, name: { en: "Bell", pl: "Dzwonek" } } });
  });
  await page.setViewportSize({ width: 650, height: 690 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${STANDALONE}/dev/gizmos/?lang=en`);
  const bell = page.getByRole("button", { name: "Bell" });
  await bell.click();
  await expect(bell).toHaveAttribute("data-hits", "1");
  expect(await page.locator(".tl-canvas").evaluate((el) => el.getAnimations().length)).toBe(0);
});
