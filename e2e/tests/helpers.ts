import { type Browser, devices, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const PHONE = devices["Pixel 7"];

type Violation = { blockedURI: string; sourceFile: string; violatedDirective: string };

declare global {
  var __cspViolations: Violation[];
}

// Installed before the first paint, so it cannot miss an early violation.
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

// The page leaves with the tabletop's own policy, so "no violations" means
// something.
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

// The board's own controls sit in tldraw's bottom bar; the sheets they open
// are dialogs named after them.
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

// What a person reads on the canvas; tldraw also measures text off-screen.
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
  // NOTE: not Escape. tldraw ignores an Escape it believes is still held,
  // and it misses the key coming up whenever that lands while a menu is
  // open or a text field has focus, which then leaves a board deaf to
  // Escape. Picking the select tool ends the edit and keeps the note
  // selected, as Escape would.
  await page.getByTestId("tools.select").click();
  await expect(onBoard(page, text)).toBeVisible();
}

export async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join the board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
}

// The newest roll log entry as it reads, without its last line: the time,
// which each screen formats from its own clock.
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

// One person rolls 2d6; the other's log shows the very same roll.
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

// A screenshot for a person to look at, written only when SHOTS_DIR names
// a folder: the suite itself writes none, and asserts on what it reads.
export async function reviewShot(page: Page, name: string): Promise<void> {
  const folder = process.env.SHOTS_DIR;
  if (folder === undefined || folder === "") return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/${name}.png` });
}

// The board's tldraw editor, found through React's own records of the
// canvas: the test then changes shapes as a person's gestures would, with
// real, synced shape updates, but without pointer drags to aim.
export async function reachEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=canvas]")!;
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
