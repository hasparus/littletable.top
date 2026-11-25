import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdirSync } from "node:fs";

export const PHONE = devices["Pixel 7"];

export async function installKeyboard(context: BrowserContext) {
  await context.addInitScript(() => {
    let keyboard = 0;
    const fake = new EventTarget();
    Object.defineProperties(fake, {
      height: { get: () => globalThis.innerHeight - keyboard },
      offsetLeft: { value: 0 },
      offsetTop: { value: 0 },
      pageLeft: { value: 0 },
      pageTop: { value: 0 },
      scale: { value: 1 },
      width: { get: () => globalThis.innerWidth },
    });
    // oxlint-disable-next-line landmines-testing/no-test-doubles -- Headless Playwright has no native mobile keyboard to resize the visual viewport.
    Object.defineProperty(globalThis, "visualViewport", { configurable: true, get: () => fake });
    Object.assign(globalThis, {
      __keyboard: (px: number) => {
        keyboard = px;
        fake.dispatchEvent(new Event("resize"));
      },
    });
  });
}

/** Simulates a keyboard covering the bottom of the visual viewport while leaving layout unchanged. */
export async function withKeyboard(page: Page, px: number) {
  await page.evaluate((height) => {
    globalThis.__keyboard(height);
  }, px);
}

type Violation = { blockedURI: string; sourceFile: string; violatedDirective: string };

declare global {
  var __cspViolations: Violation[];
  var __keyboard: (px: number) => void;
}

// WARNING: Install the CSP listener before the first paint to catch early violations.
export async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      globalThis.__cspViolations.push({
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        violatedDirective: event.violatedDirective,
      });
    });
  });
}

export async function expectNoCspViolations(page: Page): Promise<void> {
  const violations = await page.evaluate(() => globalThis.__cspViolations);
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

export async function expectOwnPolicy(page: Page, connect: string): Promise<void> {
  const response = await page.request.get(page.url());
  const policy = response.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain(`connect-src ${connect}`);
}

export async function phone(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(url);
  return page;
}

/**
 * The board's own controls sit in tldraw's bottom bar; the sheets they open
 * are dialogs named after them.
 */
export const sheet = (page: Page, name: string): Locator => page.getByRole("dialog", { name });

export async function openSheet(page: Page, name: string): Promise<Locator> {
  const panel = sheet(page, name);
  if (!(await panel.isVisible())) await page.getByRole("button", { exact: true, name }).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeSheet(page: Page, name: string): Promise<void> {
  await sheet(page, name).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page, name)).toBeHidden();
}

/** What a person reads on the canvas; tldraw also measures text off-screen. */
export const onBoard = (page: Page, text: string): Locator =>
  page.getByTestId("canvas").getByText(text, { exact: true });

export async function putNote(
  page: Page,
  { at, text }: { at: { x: number; y: number }; text: string },
): Promise<void> {
  const note = page.getByTestId("tools.note");
  if (await note.isVisible()) {
    await note.click();
  } else {
    await page.getByTestId("tools.more-button").click();
    await page.getByTestId("tools.more.note").click();
  }
  await page.mouse.click(at.x, at.y);
  await page.keyboard.type(text);
  // WARNING: tldraw can miss Escape’s keyup while a menu or text field has focus, leaving Escape stuck. Use the select tool to finish editing.
  await page.getByTestId("tools.select").click();
  await expect(onBoard(page, text)).toBeVisible();
}

export async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join the board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
}

// WARNING: Exclude the timestamp when comparing roll logs because the browsers render it from their own clocks.
async function newestRoll(log: Locator): Promise<string> {
  const entry = log.getByRole("listitem").first();
  await expect(entry).toBeVisible();
  const [text = ""] = await entry.allInnerTexts();
  const lines = text.split("\n").map((line) => line.trim());
  return lines.slice(0, -1).filter(Boolean).join(" ");
}

export async function openRollLog(dialog: Locator): Promise<Locator> {
  const log = dialog.locator("details").filter({ hasText: "Roll log" });
  if ((await log.getAttribute("open")) === null) {
    await log.getByText("Roll log", { exact: true }).click();
  }
  await expect(log).toHaveAttribute("open", "");
  return log;
}

export async function rollTwoD6(roller: Page, watcher: Page, name: string): Promise<string> {
  const dice = await openSheet(roller, "Dice");
  await dice.getByRole("button", { name: "Add d6" }).click();
  await dice.getByRole("button", { name: "Add d6" }).click();
  await dice.getByRole("button", { name: "Roll 2d6" }).click();
  await expect(dice).toBeHidden();
  const log = await openRollLog(await openSheet(roller, "Dice"));
  await expect(log.getByRole("listitem").first()).toContainText(name);
  const rolled = await newestRoll(log);
  const total = Number(/Total:\s*(\d+)/u.exec(rolled)?.[1]);
  expect(total).toBeGreaterThanOrEqual(2);
  expect(total).toBeLessThanOrEqual(12);
  const watched = await openRollLog(await openSheet(watcher, "Dice"));
  await expect.poll(async () => newestRoll(watched)).toBe(rolled);
  await closeSheet(roller, "Dice");
  await closeSheet(watcher, "Dice");
  return rolled;
}

/**
 * A screenshot for a person to look at, written only when SHOTS_DIR names
 * a folder: the suite itself writes none, and asserts on what it reads.
 */
export async function reviewShot(page: Page, name: string): Promise<void> {
  const folder = process.env.SHOTS_DIR;
  if (folder === undefined || folder === "") return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/${name}.png` });
}

/**
 * The board's tldraw editor, found through React's own records of the
 * canvas: the test then changes shapes as a person's gestures would, with
 * real, synced shape updates, but without pointer drags to aim.
 */
export async function reachEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector(
      "[data-board-shell]:not([hidden]) [data-board-editor]:not([inert]) [data-testid=canvas]",
    )!;
    const key = Object.keys(canvas).find((name) => name.startsWith("__reactFiber$"))!;
    type Fiber = { memoizedProps?: { value?: unknown }; return: Fiber | null };
    let fiber: Fiber | null = (canvas as unknown as Record<string, Fiber>)[key] ?? null;
    while (fiber !== null) {
      const value = fiber.memoizedProps?.value as { updateShape?: unknown } | undefined;
      if (typeof value?.updateShape === "function") break;
      fiber = fiber.return;
    }
    (globalThis as unknown as { __editor: unknown }).__editor = fiber!.memoizedProps!.value;
  });
}
