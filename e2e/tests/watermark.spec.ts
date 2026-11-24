import { devices, expect, type Locator, type Page, test } from "@playwright/test";

import { HOST } from "../ports";
import { closeSheet, collectCspViolations, openSheet, PHONE, reviewShot } from "./helpers";

// tldraw's licence asks that its "made with tldraw" mark stays visible,
// unobscured and open to interaction. It sits in the bottom right corner
// of the canvas: a small tab on the edge of a phone, the full mark on a
// wider screen. Nothing of the board's own may cover it: not the bottom
// bar's controls, a sheet, or the dice toast.
// NOTE: without a licence key on localhost tldraw draws the same element in
// the same place, with "Get a license for production" on wide screens.

const watermark = (page: Page): Locator => page.locator("[data-testid^='tl-watermark']");

type Box = { height: number; width: number; x: number; y: number };

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Check the visible height, including the top edge beside an open sheet.
const onTop = (page: Page) =>
  watermark(page).evaluate((mark) => {
    const box = mark.getBoundingClientRect();
    const x = box.x + box.width / 2;
    return [box.y + 0.5, box.y + box.height / 2, box.bottom - 0.5].every((y) =>
      mark.contains(document.elementFromPoint(x, y)),
    );
  });

async function expectClearOf(page: Page, other: Locator, what: string): Promise<void> {
  await expect(other).toBeVisible();
  const mark = (await watermark(page).boundingBox())!;
  expect(overlap(mark, (await other.boundingBox())!), `${what} leaves the mark alone`).toBe(false);
  expect(await onTop(page), `the mark is on top beside ${what}`).toBe(true);
}

async function expectPhoneToolbar(page: Page) {
  const tools = page.getByRole("toolbar", { exact: true, name: "Tools" });
  await expect(tools.locator("button:visible")).toHaveCount(5);
  expect(
    await tools
      .locator("button:visible")
      .evaluateAll((buttons) =>
        buttons.map((button) => (button as HTMLButtonElement).dataset.testid),
      ),
  ).toEqual(["tools.select", "tools.hand", "tools.draw", "tools.text", "tools.more-button"]);

  const toolBounds = (await tools.boundingBox())!;
  const pointerBounds = (await tools.getByTestId("tools.select").boundingBox())!;
  expect(pointerBounds.x - toolBounds.x, "pointer highlight has an even corner inset").toBeCloseTo(
    pointerBounds.y - toolBounds.y,
    0,
  );
  const actionBounds = (await page.locator("[data-board-toolbar-actions]").boundingBox())!;
  expect(toolBounds.y).toBeCloseTo(actionBounds.y, 0);
  const buttons = page.locator("[data-board-toolbar] .tlui-button__tool:visible");
  for (const button of await buttons.all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeCloseTo(box.height, 0);
    expect(box.width).toBeCloseTo(actionBounds.height, 0);
  }
  expect(toolBounds.x + toolBounds.width).toBeLessThan(actionBounds.x);

  const styles = (await page.getByTestId("mobile-styles.button").boundingBox())!;
  expect(styles.y + styles.height).toBeLessThan(toolBounds.y);
}

const SCREENS = [
  ["phone-360", { ...PHONE, viewport: { height: 740, width: 360 } }],
  ["phone-390", { ...PHONE, viewport: { height: 844, width: 390 } }],
  ["phone-430", { ...PHONE, viewport: { height: 932, width: 430 } }],
  ["tablet-660", { ...devices["Desktop Chrome"], viewport: { height: 740, width: 660 } }],
  ["tablet-740", { ...devices["Desktop Chrome"], viewport: { height: 820, width: 740 } }],
  ["desktop", devices["Desktop Chrome"]],
] as const;

for (const [name, device] of SCREENS) {
  test(`tldraw's mark stays in view and uncovered on ${name}`, async ({ browser }) => {
    const context = await browser.newContext({
      ...device,
      deviceScaleFactor: 2,
      // The toast shows at once, and stays for the shot.
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await collectCspViolations(page);
    await page.goto(`${HOST}/sign-in?name=Ada`);
    await page.getByRole("button", { name: "New board" }).click();
    await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

    const { height, width } = page.viewportSize()!;
    await expect(watermark(page)).toBeVisible();
    const mark = (await watermark(page).boundingBox())!;
    // Bottom right, inside the screen but for the tab's 2px tuck on a phone.
    expect(mark.x + mark.width).toBeGreaterThan(width - 16);
    expect(mark.x).toBeLessThan(width);
    expect(mark.y + mark.height).toBeLessThanOrEqual(height);
    expect(mark.y).toBeGreaterThan(height - 80);

    // The bottom bar, with the board's own controls in it.
    for (const control of ["Search", "People", "Dice"]) {
      await expectClearOf(page, page.getByRole("button", { exact: true, name: control }), control);
    }
    const phone = name.startsWith("phone");
    if (phone) await expectPhoneToolbar(page);
    if (name.startsWith("tablet")) {
      await page.getByTestId("minimap.zoom-menu-button").click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await reviewShot(page, `watermark-${name}`);

    for (const sheet of ["Search", "People"]) {
      const dialog = await openSheet(page, sheet);
      await expectClearOf(page, dialog, `the ${sheet} sheet`);
      if (phone) {
        const dialogBounds = (await dialog.boundingBox())!;
        const tools = (await page
          .getByRole("toolbar", { exact: true, name: "Tools" })
          .boundingBox())!;
        const actions = (await page.locator("[data-board-toolbar-actions]").boundingBox())!;
        expect(dialogBounds.x).toBeCloseTo(tools.x, 0);
        expect(dialogBounds.x + dialogBounds.width).toBeCloseTo(actions.x + actions.width, 0);
        expect(actions.y - dialogBounds.y - dialogBounds.height).toBeCloseTo(8, 0);
      }
      await closeSheet(page, sheet);
    }
    const dice = await openSheet(page, "Dice");
    await expectClearOf(page, dice, "the Dice sheet");
    await reviewShot(page, `watermark-${name}-sheet`);
    await dice.getByRole("button", { exact: true, name: "Add d20" }).click();
    await dice.getByRole("button", { name: /^Roll/u }).click();
    await closeSheet(page, "Dice");

    const toast = page.getByRole("button", { exact: true, name: "Close" });
    await expectClearOf(page, toast, "the dice toast");
    await reviewShot(page, `watermark-${name}-toast`);
    await context.close();
  });
}
