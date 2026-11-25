import { expect, test } from "@playwright/test";

import type { ChatMessage } from "../../src/chat";

import { STANDALONE } from "../ports";
import { installKeyboard, openSheet, PHONE, withKeyboard } from "./helpers";

test("phone chat follows the latest message across keyboard resizes while at the bottom", async ({
  browser,
}) => {
  const context = await browser.newContext({ ...PHONE, viewport: { height: 740, width: 360 } });
  try {
    await installKeyboard(context);
    const page = await context.newPage();
    const history: ChatMessage[] = Array.from({ length: 24 }, (_, index) => ({
      at: Date.UTC(2026, 10, 25, 14, 0, index),
      id: index + 1,
      name: "Mika",
      sub: "mika",
      text: `Message ${index + 1} from earlier in the game.`,
    }));
    await page.route("**/rooms/*/chat", (route) => route.fulfill({ json: history }));
    await page.goto(STANDALONE);
    const chat = await openSheet(page, "Chat");
    const log = chat.getByRole("log");
    const newest = log.getByText(history.at(-1)!.text, { exact: true });
    await expect(newest).toBeInViewport();

    const logHeight = () => log.evaluate((element) => element.clientHeight);
    const fromBottom = () =>
      log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    const originalHeight = await logHeight();
    const composer = chat.getByRole("textbox", { exact: true, name: "Message" });
    await composer.focus();
    await withKeyboard(page, 340);
    await expect.poll(logHeight).toBeLessThan(originalHeight);
    await expect.poll(fromBottom).toBeLessThan(1);
    await expect(newest).toBeInViewport();

    await withKeyboard(page, 0);
    await expect.poll(logHeight).toBe(originalHeight);
    await log.evaluate((element) => {
      element.scrollTop = 80;
    });
    // WARNING: Let the scroll event update follow mode before resizing the viewport.
    await log.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect.poll(fromBottom).toBeGreaterThan(32);

    await withKeyboard(page, 340);
    await expect.poll(logHeight).toBeLessThan(originalHeight);
    await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(80);
    await expect(newest).not.toBeInViewport();
  } finally {
    await context.close();
  }
});
