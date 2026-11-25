import { expect, type Locator, type Page, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { closeSheet, installKeyboard, openSheet, PHONE, withKeyboard } from "./helpers";

const posts = [
  "Should we take the stairs or try the locked door?",
  "I can check the lock. Listen for footsteps behind us while I work.",
  "Let’s try the door. I’ll keep watch at the stairs.",
  "I rolled a 17. Does that tell me anything about what’s on the other side?",
  "You hear machinery moving in the next room. Something is picking up speed.",
  "I’ll grab the map and join you. Stay just out of sight.",
];

async function openThread(page: Page) {
  await page.route("**/rooms/*/chat", (route) =>
    route.fulfill({
      json: Array.from({ length: 24 }, (_, index) => ({
        at: Date.UTC(2026, 10, 25, 14, 0, index),
        id: index + 1,
        name: index % 2 === 0 ? "Mika" : "Nora",
        sub: index % 2 === 0 ? "mika" : "nora",
        text: posts[index % posts.length],
      })),
    }),
  );
  await page.goto(STANDALONE);
  const chat = await openSheet(page, "Chat");
  await expect(chat.locator("article")).toHaveCount(24);
  return chat;
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function capture(chat: Locator, name: string) {
  if (process.env.SHOTS_DIR) {
    await chat.screenshot({ path: `${process.env.SHOTS_DIR}/chat-resize-${name}.png` });
  }
}

test("desktop chat resizes by mouse and keyboard and keeps the message being read", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 900 });
  const chat = await openThread(page);
  const grip = chat.getByRole("button", { name: "Resize chat" });
  const log = chat.getByRole("log");
  const original = await box(chat);
  expect(original.width).toBe(384);
  await capture(chat, "desktop-default");

  await log.evaluate((element) => {
    element.scrollTop = 320;
  });
  await log.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const anchor = await log.evaluate((element) => {
    const { top } = element.getBoundingClientRect();
    return [...element.children].findIndex(
      (message) => message.getBoundingClientRect().bottom > top,
    );
  });

  const handle = await box(grip);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 115, y - 130, { steps: 8 });
  await page.mouse.up();
  const enlarged = await box(chat);
  expect(enlarged.width).toBeGreaterThan(original.width + 200);
  expect(enlarged.height).toBeGreaterThan(original.height + 100);
  expect(enlarged.y + enlarged.height).toBeCloseTo(original.y + original.height, 0);
  const priorMessage = log.locator("article").nth(anchor);
  await expect(priorMessage).toBeInViewport();
  await capture(chat, "desktop-expanded");

  await grip.press("ArrowRight");
  await grip.press("ArrowUp");
  const keyboard = await box(chat);
  expect(keyboard.width).toBeGreaterThan(enlarged.width);
  expect(keyboard.height).toBeGreaterThan(enlarged.height);

  const nextHandle = await box(grip);
  await page.mouse.move(nextHandle.x + nextHandle.width / 2, nextHandle.y + nextHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(899, 0, { steps: 8 });
  await page.mouse.up();
  const bounded = await box(chat);
  expect(bounded.x).toBeGreaterThanOrEqual(8);
  expect(bounded.y).toBeGreaterThanOrEqual(8);
  expect(bounded.x + bounded.width).toBeLessThanOrEqual(892);

  await closeSheet(page, "Chat");
  await openSheet(page, "Chat");
  const reopened = await box(chat);
  expect(reopened.width).toBeCloseTo(bounded.width, 0);
  await grip.press("Enter");
  const reset = await box(chat);
  expect(reset.width).toBe(original.width);
  expect(reset.height).toBe(original.height);
});

test("phone chat resizes by touch and leaves the composer above the keyboard", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...PHONE,
    deviceScaleFactor: 2,
    viewport: { height: 740, width: 360 },
  });
  try {
    await installKeyboard(context);
    const page = await context.newPage();
    const chat = await openThread(page);
    const grip = chat.getByRole("button", { name: "Resize chat" });
    const original = await box(chat);
    await capture(chat, "phone-default");

    const handle = await box(grip);
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { touchPoints: [{ x, y }], type: "touchStart" });
    for (const distance of [30, 60, 110, 170]) {
      await cdp.send("Input.dispatchTouchEvent", {
        touchPoints: [{ x: x + distance / 4, y: y - distance }],
        type: "touchMove",
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
    const enlarged = await box(chat);
    expect(enlarged.width).toBe(original.width);
    expect(enlarged.height).toBeGreaterThan(original.height + 100);
    await capture(chat, "phone-expanded");

    const composer = chat.getByRole("textbox", { name: "Message" });
    await composer.focus();
    await withKeyboard(page, 340);
    const height = async () => {
      const rect = await box(chat);
      return rect.height;
    };
    await expect.poll(height).toBeLessThan(enlarged.height);
    const input = await box(composer);
    expect(input.y + input.height).toBeLessThan(400);
    await expect(composer).toBeInViewport();
    await expect(chat.locator("article").last()).toBeInViewport();
    await withKeyboard(page, 0);
    await expect.poll(height).toBe(enlarged.height);
    await grip.press("ArrowDown");
    expect(await height()).toBeLessThan(enlarged.height);
  } finally {
    await context.close();
  }
});
