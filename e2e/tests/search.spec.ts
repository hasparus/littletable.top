import { type Browser, devices, expect, type Page, test } from "@playwright/test";

import { HOST, STANDALONE } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  installKeyboard,
  joinAs,
  onBoard,
  openSheet,
  PHONE,
  putNote,
  reviewShot,
  sheet,
  withKeyboard,
} from "./helpers";

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.SHOTS_DIR) {
    await page
      .locator("#board-search")
      .evaluateAll((panels) =>
        Promise.allSettled(
          panels.flatMap((panel) => panel.getAnimations().map(({ finished }) => finished)),
        ),
      );
  }
  await reviewShot(page, `search-${name}`);
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

test("Board index previews places and keeps the canvas available after a jump", async ({
  page,
}) => {
  await newBoard(page);
  await putNote(page, { at: { x: 400, y: 210 }, text: "Basic Moves" });
  await nameAsPlace(page, "Basic Moves");
  await putNote(page, { at: { x: 850, y: 430 }, text: "The Old Road" });
  await nameAsPlace(page, "The Old Road");

  const index = await openSheet(page, "Search");
  await shot(page, "desktop-index");
  const moves = index.getByRole("button", { exact: true, name: "Basic Moves" });
  const road = index.getByRole("button", { exact: true, name: "The Old Road" });
  const preview = page.locator("[data-board-place-preview]");
  await moves.hover();
  await expect(preview).toBeVisible();
  await shot(page, "desktop-index-preview");
  await page.mouse.move(550, 135);
  await expect(preview).toHaveCount(0);
  await road.focus();
  await expect(preview).toBeVisible();

  await moves.click();
  await expect(index).toBeVisible();
  await expect
    .poll(async () => {
      const { x, width } = (await index.boundingBox())!;
      return (await onBoard(page, "Basic Moves").boundingBox())!.x - (x + width);
    })
    .toBeGreaterThan(0);
  await road.click();
  await expect(index).toBeVisible();
  await expect(onBoard(page, "The Old Road")).toBeInViewport();

  await putNote(page, { at: { x: 960, y: 590 }, text: "New note with index open" });
  await expect(index).toBeVisible();
  await page.getByTestId("main-menu.button").click();
  await page.getByRole("menuitem", { name: "Background color" }).hover();
  await expect(page.getByRole("menuitemcheckbox", { name: "Default" })).toBeVisible();
  await expectNoCspViolations(page);
});

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

  const search = await openSheet(bea, "Search");
  await expect(field(bea)).not.toBeFocused();
  const tavern = search.getByRole("button", { exact: true, name: "Tavern Page 1" });
  await expect(tavern).toBeVisible();
  await shot(bea, "phone-empty");
  await tavern.tap();
  await expect(search).toBeVisible();
  await expect
    .poll(async () => {
      const place = (await onBoard(bea, "Tavern").boundingBox())!;
      return (await search.boundingBox())!.y - below(place);
    })
    .toBeGreaterThan(0);

  await field(bea).fill("tav");
  await expect(options(bea)).toHaveText([/^Place: Tavern\s*Page 1$/u, /Tavern ledger.*Crypt$/u]);
  await shot(bea, "phone-results");

  await field(bea).fill("zolw");
  await expect(options(bea)).toHaveText([/^Żółw pod kamieniem\s*Crypt$/u]);
  await field(bea).fill("kamienem");
  await expect(options(bea)).toHaveText([/^Żółw pod kamieniem\s*Crypt$/u]);

  await options(bea).first().tap();
  await expect(sheet(bea, "Search")).toBeHidden();
  await expect(field(bea)).toHaveCount(0);
  await expect(pageButton(bea)).toHaveText("Crypt");
  await expect(found(bea, "Żółw pod kamieniem")).toBeVisible();
  await expect(onBoard(bea, "Żółw pod kamieniem")).toBeInViewport();
  await shot(bea, "phone-highlight");
  await expect(found(ada, /^Found/u)).toHaveCount(0);
  await expect(found(bea, "Żółw pod kamieniem")).toHaveCount(0, { timeout: 5000 });

  await openSheet(bea, "Search");
  await field(bea).fill("zolw");
  await expect(options(bea)).toHaveCount(1);
  await onBoard(ada, "Żółw pod kamieniem").click();
  await ada.keyboard.press("Delete");
  await expect(onBoard(ada, "Żółw pod kamieniem")).toHaveCount(0);
  await expect(
    bea.getByRole("status").filter({ hasText: "Nothing on the board matches “zolw”." }),
  ).toBeVisible();
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

  const button = page.getByRole("button", { exact: true, name: "Search" });
  await button.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(sheet(page, "Search")).toBeVisible();
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet(page, "Search")).toBeHidden();
  await expect(button).toBeFocused();

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

const KEYBOARD_PX = 340;

const below = (box: { height: number; y: number }) => box.y + box.height;

test("phone search fits a panned keyboard viewport and restores the board controls when closed", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...PHONE,
    reducedMotion: "reduce",
    viewport: { height: 740, width: 360 },
  });
  try {
    await installKeyboard(context);
    const page = await context.newPage();
    await page.goto(STANDALONE);
    const toolbar = page.locator("[data-board-toolbar]");
    await expect(toolbar).toBeVisible();
    const original = await toolbar.boundingBox();
    const search = await openSheet(page, "Search");
    await field(page).tap();
    await withKeyboard(page, 340, 260);

    await expect.poll(async () => below((await search.boundingBox())!)).toBe(652);
    const active = await search.boundingBox();
    expect(active?.y).toBeGreaterThanOrEqual(268);

    // WARNING: Simulate Safari scrolling the layout viewport while an input is focused.
    await page.evaluate(() => {
      document.body.style.minHeight = "calc(100vh + 300px)";
      window.scrollTo(0, 90);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(90);
    await search.getByRole("button", { name: "Close" }).dispatchEvent("click");
    await expect(search).toBeHidden();
    await withKeyboard(page, 0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect.poll(() => toolbar.boundingBox()).toEqual(original);
  } finally {
    await context.close();
  }
});

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
  await installKeyboard(context);
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
  const matches = list.getByRole("option");
  await expect(matches).toHaveCount(3);
  const input = field(bea, "Szukaj na tablicy");
  const match = matches.first();
  const inputBox = (await input.boundingBox())!;
  const matchBox = (await match.boundingBox())!;
  const closeBox = (await search.locator("header button").boundingBox())!;
  expect(matchBox.x).toBeCloseTo(inputBox.x, 0);
  expect(matchBox.x + matchBox.width).toBeCloseTo(closeBox.x + closeBox.width, 0);
  expect((await match.locator("svg").boundingBox())!.x).toBeCloseTo(
    (await search.locator("header svg").first().boundingBox())!.x,
    0,
  );
  const textStart = await input.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingLeft),
  );
  expect((await match.locator("svg + span").boundingBox())!.x).toBeCloseTo(
    inputBox.x + textStart,
    0,
  );

  const { height } = bea.viewportSize()!;
  await expect
    .poll(async () => below((await search.boundingBox())!))
    .toBeLessThanOrEqual(height - KEYBOARD_PX);
  expect(below((await list.boundingBox())!)).toBeLessThanOrEqual(height - KEYBOARD_PX);
  await expect(field(bea, "Szukaj na tablicy")).toBeInViewport();
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
