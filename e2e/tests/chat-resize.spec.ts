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
  await settleSheet(chat);
  return chat;
}

async function settleSheet(chat: Locator) {
  await chat.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function dragBorder(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function capture(chat: Locator, name: string) {
  if (process.env.SHOTS_DIR) {
    await chat.screenshot({ path: `${process.env.SHOTS_DIR}/chat-resize-${name}.png` });
  }
}

for (const textSize of ["default", "compact"]) {
  test(`shrinking a newly opened empty chat with ${textSize} text never enlarges it`, async ({
    page,
  }) => {
    await page.route("**/rooms/*/chat", (route) => route.fulfill({ json: [] }));
    await page.goto(STANDALONE);
    if (textSize === "compact") {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "12px";
      });
    }
    const chat = await openSheet(page, "Chat");
    await expect(chat.getByText("No messages yet.")).toBeVisible();
    await settleSheet(chat);
    const initial = await box(chat);
    await chat.getByRole("separator", { name: "Resize chat" }).press("ArrowDown");
    const resized = await box(chat);
    if (textSize === "compact") {
      expect(resized.height).toBe(initial.height);
      await expect(chat).toHaveAttribute("data-chat-size", "natural");
    } else {
      expect(resized.height).toBeLessThan(initial.height);
    }
  });
}

test("desktop chat resizes by mouse and keyboard and keeps the message being read", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 900 });
  const chat = await openThread(page);
  const resizeControl = chat.getByRole("separator", { name: "Resize chat", exact: true });
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

  for (const [edge, dx, dy] of [
    ["top", 0, -42],
    ["left", -48, 0],
    ["right", 60, 0],
    ["top-left", -36, -24],
    ["top-right", 32, -28],
    ["bottom", 0, -26],
    ["bottom-left", -20, -18],
    ["bottom-right", 18, -16],
  ] as const) {
    await test.step(`drag the ${edge} border`, async () => {
      const before = await box(chat);
      const left = edge.includes("left");
      const top = edge.includes("top");
      const right = edge.includes("right");
      const bottom = edge.includes("bottom");
      const startX = before.x + (left ? 2 : right ? before.width - 2 : before.width / 2);
      const startY = before.y + (top ? 2 : bottom ? before.height - 2 : before.height / 2);
      await dragBorder(page, startX, startY, dx, dy);
      await expect(resizeControl).toBeFocused();
      const after = await box(chat);
      expect(after.x).toBeCloseTo(before.x + (left ? dx : 0), 0);
      expect(after.y).toBeCloseTo(before.y + (top ? dy : 0), 0);
      expect(after.x + after.width).toBeCloseTo(before.x + before.width + (right ? dx : 0), 0);
      expect(after.y + after.height).toBeCloseTo(before.y + before.height + (bottom ? dy : 0), 0);
    });
  }
  const enlarged = await box(chat);
  await page.mouse.click(enlarged.x + enlarged.width / 2, enlarged.y + 2);
  expect(await box(chat)).toEqual(enlarged);
  const priorMessage = log.locator("article").nth(anchor);
  await expect(priorMessage).toBeInViewport();
  await capture(chat, "desktop-expanded");

  await expect(resizeControl).toHaveAttribute("aria-valuenow", String(Math.round(enlarged.height)));
  await resizeControl.press("ArrowRight");
  await resizeControl.press("ArrowUp");
  const keyboard = await box(chat);
  expect(keyboard.width).toBeGreaterThan(enlarged.width);
  expect(keyboard.height).toBeGreaterThan(enlarged.height);

  const right = keyboard.x + keyboard.width - 2;
  await dragBorder(page, right, keyboard.y + 2, 899 - right, -keyboard.y);
  const bounded = await box(chat);
  expect(bounded.x).toBeGreaterThanOrEqual(8);
  expect(bounded.y).toBeGreaterThanOrEqual(8);
  expect(bounded.x + bounded.width).toBeLessThanOrEqual(892);

  await closeSheet(page, "Chat");
  await openSheet(page, "Chat");
  await settleSheet(chat);
  const reopened = await box(chat);
  expect(reopened.width).toBeCloseTo(bounded.width, 0);
  await resizeControl.press("Enter");
  const reset = await box(chat);
  expect(reset).toEqual(original);
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
    const resizeControl = chat.getByRole("separator", { name: "Resize chat", exact: true });
    const original = await box(chat);
    await capture(chat, "phone-default");

    const cdp = await context.newCDPSession(page);
    for (const fraction of [0.12, 0.5, 0.88]) {
      const before = await box(chat);
      const x = before.x + before.width * fraction;
      const y = before.y + 2;
      await cdp.send("Input.dispatchTouchEvent", { touchPoints: [{ x, y }], type: "touchStart" });
      for (const distance of [15, 30, 50]) {
        await cdp.send("Input.dispatchTouchEvent", {
          touchPoints: [{ x: x + distance / 4, y: y - distance }],
          type: "touchMove",
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
      await expect(resizeControl).toBeFocused();
      const after = await box(chat);
      expect(after.x).toBe(before.x);
      expect(after.width).toBe(before.width);
      expect(after.height).toBeCloseTo(before.height + 50, 0);
      expect(after.y + after.height).toBeCloseTo(before.y + before.height, 0);
    }
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
    await resizeControl.press("ArrowDown");
    expect(await height()).toBeLessThan(enlarged.height);
  } finally {
    await context.close();
  }
});
