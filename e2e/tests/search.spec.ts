import { type Browser, devices, expect, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { HOST } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  onBoard,
  openSheet,
  PHONE,
  putNote,
  sheet,
} from "./helpers";

// Searching the board, against the hosted Worker: text one person types on
// another page is found by someone else, choosing a result goes to its
// page and flashes it there, places are found too, Polish letters fold
// both ways, typos are forgiven, and a deleted shape leaves the results.
// On a desktop the search is a keyboard path; on a phone its results stay
// above the on-screen keyboard and leave tldraw's mark alone. The
// artifacts are the assertions and the screenshots.

const SHOTS = "/home/user/ludamus/screenshots/board";

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/search-${name}.png` });
}

const DESKTOP = { ...devices["Desktop Chrome"], deviceScaleFactor: 2 };
const PHONE_2X = { ...PHONE, deviceScaleFactor: 2 };

const pageButton = (page: Page) => page.getByTestId("page-menu.button");
const field = (page: Page, name = "Search the board") => page.getByRole("combobox", { name });
const results = (page: Page, name = "Results") => page.getByRole("listbox", { name });
const found = (page: Page, text: RegExp | string) =>
  page.getByRole("img", { name: typeof text === "string" ? `Found: ${text}` : text });

async function newBoard(page: Page): Promise<string> {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Ada`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  return page.url();
}

async function guest(browser: Browser, url: string, device: object): Promise<Page> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(url);
  await joinAs(page, "Bea");
  return page;
}

async function addPage(page: Page, name: string): Promise<void> {
  await pageButton(page).click();
  await page.getByTestId("page-menu.create").click();
  const name_ = page.getByTestId("page-menu.list").getByRole("textbox");
  await name_.fill(name);
  await name_.press("Enter");
  await expect(pageButton(page)).toHaveText(name);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-menu.list")).toBeHidden();
}

async function nameAsPlace(page: Page, name: string): Promise<void> {
  const search = await openSheet(page, "Search");
  await search.getByRole("button", { name: "Add to places" }).click();
  await search.getByLabel("Place name").fill(name);
  await search.getByRole("button", { name: "Save" }).click();
  await expect(search.getByRole("button", { exact: true, name })).toBeVisible();
  await closeSheet(page, "Search");
}

const options = (page: Page) => results(page).getByRole("option");

test("someone on another page finds what was typed, goes there and sees it flash", async ({
  browser,
  page: ada,
}) => {
  const boardUrl = await newBoard(ada);
  await putNote(ada, { at: { x: 320, y: 260 }, text: "Tavern" });
  await nameAsPlace(ada, "Tavern");
  await addPage(ada, "Crypt");
  await putNote(ada, { at: { x: 900, y: 600 }, text: "Żółw pod kamieniem" });
  await putNote(ada, { at: { x: 300, y: 600 }, text: "Tavern ledger: three coins" });

  const bea = await guest(browser, boardUrl, PHONE_2X);
  await expect(pageButton(bea)).toHaveText("Page 1");

  // Nothing typed: the places, the board's own way around.
  const search = await openSheet(bea, "Search");
  await expect(field(bea)).not.toBeFocused();
  await expect(search.getByRole("button", { exact: true, name: "Tavern Page 1" })).toBeVisible();
  await shot(bea, "phone-empty");

  // A place and a note on another page, the place first, each with its page.
  await field(bea).fill("tav");
  await expect(options(bea)).toHaveText([/^Place: Tavern\s*Page 1$/u, /Tavern ledger.*Crypt$/u]);
  await shot(bea, "phone-results");

  // Without its diacritics, and with a typo.
  await field(bea).fill("zolw");
  await expect(options(bea)).toHaveText([/^Żółw pod kamieniem\s*Crypt$/u]);
  await field(bea).fill("kamienem");
  await expect(options(bea)).toHaveText([/^Żółw pod kamieniem\s*Crypt$/u]);

  // Choosing it puts the keyboard away and shows the note, flashing, on its page.
  await options(bea).first().tap();
  await expect(sheet(bea, "Search")).toBeHidden();
  await expect(field(bea)).toHaveCount(0);
  await expect(pageButton(bea)).toHaveText("Crypt");
  await expect(found(bea, "Żółw pod kamieniem")).toBeVisible();
  await expect(onBoard(bea, "Żółw pod kamieniem")).toBeInViewport();
  await shot(bea, "phone-highlight");
  // The flash is Bea's alone, and it goes.
  await expect(found(ada, /^Found/u)).toHaveCount(0);
  await expect(found(bea, "Żółw pod kamieniem")).toHaveCount(0, { timeout: 5000 });

  // Ada deletes the note; it leaves Bea's open results.
  await openSheet(bea, "Search");
  await field(bea).fill("zolw");
  await expect(options(bea)).toHaveCount(1);
  await onBoard(ada, "Żółw pod kamieniem").click();
  await ada.keyboard.press("Delete");
  await expect(onBoard(ada, "Żółw pod kamieniem")).toHaveCount(0);
  await expect(
    bea.getByRole("status").filter({ hasText: "Nothing on the board matches “zolw”." }),
  ).toBeVisible();
  // The places stay in reach when nothing matches.
  await expect(
    sheet(bea, "Search").getByRole("button", { exact: true, name: "Tavern Page 1" }),
  ).toBeVisible();

  await expectNoCspViolations(ada);
  await expectNoCspViolations(bea);
  await bea.context().close();
});

test("on a desktop, Ctrl+F searches the board, arrows choose, Enter goes, Escape clears, then returns", async ({
  browser,
}) => {
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  await newBoard(page);
  await putNote(page, { at: { x: 300, y: 300 }, text: "Red dragon" });
  await putNote(page, { at: { x: 600, y: 300 }, text: "Green dragon" });
  await putNote(page, { at: { x: 900, y: 300 }, text: "Dragons in the hoard" });

  // Escape gives focus back to where it was.
  const button = page.getByRole("button", { exact: true, name: "Search" });
  await button.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(sheet(page, "Search")).toBeVisible();
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet(page, "Search")).toBeHidden();
  await expect(button).toBeFocused();

  // From the canvas too, and with a mouse the field takes focus at once.
  await page.getByTestId("canvas").click({ position: { x: 600, y: 600 } });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type("drag");
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const last = options(page).nth(2);
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(field(page)).toHaveAttribute(
    "aria-activedescendant",
    (await last.getAttribute("id"))!,
  );
  const chosen = (await last.textContent())!;
  await shot(page, "desktop");

  // Escape clears what was typed and stays; pressed again, it closes.
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toBeFocused();
  await expect(options(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet(page, "Search")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+f");
  await page.keyboard.type("drag");
  await page.keyboard.press("ArrowUp");
  await expect(last).toHaveAttribute("aria-selected", "true");

  // Pressed again while open, Ctrl+F goes back to the field.
  await page.getByRole("dialog", { name: "Search" }).getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(field(page)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(sheet(page, "Search")).toBeHidden();
  await expect(found(page, chosen)).toBeVisible();
  await expect(onBoard(page, chosen)).toBeInViewport();
  await shot(page, "desktop-highlight");
  await expectNoCspViolations(page);
  await context.close();
});

// Stands in for an on-screen keyboard: the visual viewport loses the
// bottom `px` of the screen, as on iOS and Android, while the layout
// viewport keeps its size.
async function withKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((height) => {
    (globalThis as unknown as { __keyboard: (px: number) => void }).__keyboard(height);
  }, px);
}

const KEYBOARD_PX = 340;

const below = (box: { height: number; y: number }) => box.y + box.height;

test("on a phone, in Polish, the results stand above the keyboard and leave tldraw's mark alone", async ({
  browser,
  page: ada,
}) => {
  const boardUrl = await newBoard(ada);
  for (const [index, text] of [
    "Smok wawelski",
    "Smocza jama",
    "Smok na moście",
    "Smoki i lochy",
  ].entries()) {
    await putNote(ada, {
      at: { x: 240 + 260 * (index % 3), y: 260 + 240 * Math.floor(index / 3) },
      text,
    });
  }

  const context = await browser.newContext({ ...PHONE_2X, viewport: { height: 740, width: 360 } });
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
    Object.defineProperty(globalThis, "visualViewport", { configurable: true, get: () => fake });
    Object.assign(globalThis, {
      __keyboard: (px: number) => {
        keyboard = px;
        fake.dispatchEvent(new Event("resize"));
      },
    });
  });
  const bea = await context.newPage();
  await collectCspViolations(bea);
  await bea.goto(`${boardUrl}?lang=pl`);
  await bea.getByLabel("Twoje imię").fill("Bea");
  await bea.getByRole("button", { name: "Dołącz do tablicy" }).click();
  await bea.getByRole("button", { exact: true, name: "Szukaj" }).tap();
  const search = sheet(bea, "Szukaj");
  await expect(search).toBeVisible();
  await expect(search.getByText("Nie ma jeszcze miejsc.", { exact: false })).toBeVisible();

  await field(bea, "Szukaj na tablicy").tap();
  await withKeyboard(bea, KEYBOARD_PX);
  await bea.keyboard.type("smok");
  const list = results(bea, "Wyniki");
  await expect(list.getByRole("option")).toHaveCount(3);
  const { height } = bea.viewportSize()!;
  await expect
    .poll(async () => below((await search.boundingBox())!))
    .toBeLessThanOrEqual(height - KEYBOARD_PX);
  expect(below((await list.boundingBox())!)).toBeLessThanOrEqual(height - KEYBOARD_PX);
  await expect(field(bea, "Szukaj na tablicy")).toBeInViewport();
  // What the screen would show above a keyboard: the board, the sheet on it.
  await bea.evaluate((px) => {
    const keys = document.createElement("div");
    keys.id = "e2e-keyboard";
    keys.style.cssText = `position:fixed;inset:auto 0 0 0;height:${px}px;background:#d1d5db;z-index:9999`;
    document.body.append(keys);
  }, KEYBOARD_PX);
  await shot(bea, "polish");
  await bea.evaluate(() => document.querySelector("#e2e-keyboard")?.remove());

  await list.getByRole("option").first().tap();
  await expect(search).toBeHidden();
  await withKeyboard(bea, 0);
  await expect(bea.getByRole("img", { name: /^Znaleziono: Smok/u })).toBeInViewport();

  // tldraw's mark is what a tap on it reaches.
  const mark = bea.locator("[data-testid^='tl-watermark']");
  await expect(mark).toBeVisible();
  const reached = await mark.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && element.contains(hit);
  });
  expect(reached).toBe(true);
  await expectNoCspViolations(bea);
  await context.close();
});
