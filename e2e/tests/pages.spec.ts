import { type Browser, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

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
} from "./helpers";
import { documentOf, downloadTldr, fixture, openTldr, toast } from "./tldr";

// A board with more than one page, against the hosted Worker: a
// member at a desktop and a guest on a phone manage pages together, find
// each other's places and each other across pages, and survive a page being
// deleted under them. The artifacts are the assertions and the screenshots.

const SHOTS = "/home/user/ludamus/screenshots/board";

const DESKTOP = { ...devices["Desktop Chrome"], deviceScaleFactor: 2 };
const phoneAt = (width: number) => ({
  ...PHONE,
  deviceScaleFactor: 2,
  viewport: { height: 844, width },
});

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/pages-${name}.png` });
}

const pageButton = (page: Page) => page.getByTestId("page-menu.button");

const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;

// A phone is touched, so tldraw takes its pointer as coarse, as it would.
const press = async (page: Page, target: Locator) =>
  onPhone(page) ? target.tap() : target.click();

async function openPages(page: Page) {
  const list = page.getByTestId("page-menu.list");
  if (!(await list.isVisible())) await press(page, pageButton(page));
  await expect(list).toBeVisible();
  return list;
}

async function closePages(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-menu.list")).toBeHidden();
}

// The page names in the menu, top to bottom.
async function pagesListed(page: Page): Promise<string[]> {
  const list = await openPages(page);
  return list.getByTestId("page-menu.item").allInnerTexts();
}

async function openPageItemMenu(page: Page, name: string): Promise<void> {
  const list = await openPages(page);
  const item = list.getByTestId("page-menu.item").filter({ hasText: name });
  await press(page, item.getByTestId("page-menu.item-submenu"));
}

const choose = async (page: Page, action: string) =>
  press(page, page.getByRole("menuitem", { name: action }));

async function pageItemAction(page: Page, name: string, action: string): Promise<void> {
  await openPageItemMenu(page, name);
  await choose(page, action);
}

// tldraw asks a phone for a name with the browser's own prompt, and a
// desktop in place.
async function renamePage(page: Page, { from, to }: { from: string; to: string }) {
  const phone = onPhone(page);
  if (phone) page.once("dialog", (dialog) => void dialog.accept(to));
  await pageItemAction(page, from, "Rename");
  if (!phone) {
    const field = page.getByTestId("page-menu.list").getByRole("textbox");
    await field.fill(to);
    await field.press("Enter");
  }
}

async function goToPage(page: Page, name: string): Promise<void> {
  const list = await openPages(page);
  await press(
    page,
    list
      .getByTestId("page-menu.item")
      .filter({ hasText: name })
      .getByRole("button", { name: "Go to page" }),
  );
  await expect(pageButton(page)).toHaveText(name);
  if (await list.isVisible()) await closePages(page);
}

async function joinPhone(
  browser: Browser,
  url: string,
  { language, name, width }: { language: "en" | "pl"; name: string; width: number },
): Promise<Page> {
  const context = await browser.newContext(phoneAt(width));
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(language === "pl" ? `${url}?lang=pl` : url);
  if (language === "en") {
    await joinAs(page, name);
  } else {
    await page.getByLabel("Twoje imię").fill(name);
    await page.getByRole("button", { name: "Dołącz do tablicy" }).click();
    await expect(page.getByRole("button", { exact: true, name: "Kości" })).toBeVisible();
  }
  return page;
}

test("pages are made, renamed, reordered and deleted together, and places and people span them", async ({
  browser,
}) => {
  const desk = await browser.newContext(DESKTOP);
  const ada = await desk.newPage();
  await collectCspViolations(ada);
  await ada.goto(`${HOST}/sign-in?name=Ada`);
  await ada.getByRole("button", { name: "New board" }).click();
  await expect(ada.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const boardUrl = ada.url();
  const bea = await joinPhone(browser, boardUrl, { language: "en", name: "Bea", width: 390 });

  // One page: its place carries no page.
  await putNote(ada, { at: { x: 300, y: 300 }, text: "Gate" });
  const adaPlaces = await openSheet(ada, "Places");
  await adaPlaces.getByRole("button", { name: "Add to places" }).click();
  await adaPlaces.getByLabel("Place name").fill("Gate");
  await adaPlaces.getByRole("button", { name: "Save" }).click();
  await expect(adaPlaces.getByRole("button", { exact: true, name: "Gate" })).toBeVisible();
  await closeSheet(ada, "Places");

  // Ada makes a second page and names it; Bea sees it at once.
  await openPages(ada);
  await ada.getByTestId("page-menu.create").click();
  const field = ada.getByTestId("page-menu.list").getByRole("textbox");
  await field.fill("Crypt");
  await field.press("Enter");
  await expect(pageButton(ada)).toHaveText("Crypt");
  await closePages(ada);
  await expect.poll(async () => pagesListed(bea)).toEqual(["Page 1", "Crypt"]);
  await closePages(bea);

  // Both rename at once, then both reorder at once: they end up agreeing.
  await Promise.all([
    renamePage(bea, { from: "Page 1", to: "Town" }),
    renamePage(ada, { from: "Crypt", to: "Vault" }),
  ]);
  await expect.poll(async () => pagesListed(ada)).toEqual(["Town", "Vault"]);
  await expect.poll(async () => pagesListed(bea)).toEqual(["Town", "Vault"]);
  // NOTE: tldraw closes an open page menu when a page record arrives, so
  // both menus are open first and both choices land in the same instant.
  // A late sync can still close one of them first, so they open again
  // until both stay open.
  const moveUp = ada.getByRole("menuitem", { name: "Move up" });
  const moveDown = bea.getByRole("menuitem", { name: "Move down" });
  await expect(async () => {
    for (const screen of [ada, bea]) {
      await screen.keyboard.press("Escape");
      await screen.keyboard.press("Escape");
    }
    await openPageItemMenu(ada, "Vault");
    await openPageItemMenu(bea, "Town");
    await expect(moveUp).toBeVisible({ timeout: 1000 });
    await expect(moveDown).toBeVisible({ timeout: 1000 });
  }).toPass();
  await Promise.all([moveUp.dispatchEvent("click"), moveDown.dispatchEvent("click")]);
  await expect.poll(async () => pagesListed(ada)).toEqual(["Vault", "Town"]);
  await expect.poll(async () => pagesListed(bea)).toEqual(["Vault", "Town"]);
  await closePages(bea);
  await renamePage(ada, { from: "Vault", to: "Crypt" });
  await expect.poll(async () => pagesListed(bea)).toEqual(["Crypt", "Town"]);
  await shot(bea, "phone-390-menu");
  await closePages(bea);
  await expect(pageButton(bea)).toHaveText("Town");

  // A reload keeps the pages, their order, and the page this tab was on,
  // though it is not the first.
  await goToPage(ada, "Town");
  await ada.reload();
  await expect(pageButton(ada)).toHaveText("Town");
  expect(await pagesListed(ada)).toEqual(["Crypt", "Town"]);
  await shot(ada, "desktop-menu");
  await closePages(ada);

  // The page control on the narrowest and widest phones, in Polish and English.
  for (const [width, language, name] of [
    [360, "pl", "Cyd"],
    [430, "en", "Dot"],
  ] as const) {
    const visitor = await joinPhone(browser, boardUrl, { language, name, width });
    await expect(pageButton(visitor)).toBeVisible();
    await shot(visitor, `phone-${width}-${language}`);
    await openPages(visitor);
    await shot(visitor, `phone-${width}-${language}-menu`);
    await expectNoCspViolations(visitor);
    await visitor.context().close();
  }

  // A place on Crypt shows up for Bea on Town, labelled with its page; the
  // jump takes her there with the place in view.
  await goToPage(ada, "Crypt");
  await putNote(ada, { at: { x: 1100, y: 250 }, text: "Altar" });
  const placesOnCrypt = await openSheet(ada, "Places");
  await placesOnCrypt.getByRole("button", { name: "Add to places" }).click();
  await placesOnCrypt.getByLabel("Place name").fill("Altar");
  await placesOnCrypt.getByRole("button", { name: "Save" }).click();
  await closeSheet(ada, "Places");
  const beaPlaces = await openSheet(bea, "Places");
  const altar = beaPlaces.getByRole("button", { exact: true, name: "Altar Crypt" });
  await expect(altar).toBeVisible();
  await expect(beaPlaces.getByRole("button", { exact: true, name: "Gate Town" })).toBeVisible();
  // Bea's own place stays first, whichever page it is on.
  await beaPlaces.getByRole("button", { name: "My place: Gate" }).click();
  await expect(beaPlaces.getByRole("listitem").first()).toContainText("GateTownMy place");
  await shot(bea, "places-two-pages");
  await altar.click();
  await expect(pageButton(bea)).toHaveText("Crypt");
  await expect(onBoard(bea, "Altar")).toBeInViewport();

  // People show who is on which page; Bea follows Ada to hers, then stops.
  await goToPage(ada, "Town");
  const people = await openSheet(bea, "People");
  // The visitors who left are gone from the list.
  await expect(people.getByRole("listitem")).toHaveCount(2, { timeout: 30_000 });
  const adaRow = people.getByRole("button", { name: /^Ada/u });
  await expect(adaRow).toContainText("Town");
  await expect(people.getByRole("listitem").filter({ hasText: "Bea" })).toContainText("Crypt");
  await shot(bea, "people");
  await adaRow.click();
  await expect(people).toBeHidden();
  await expect(pageButton(bea)).toHaveText("Town");
  const following = await openSheet(bea, "People");
  await following.getByRole("button", { name: /^Ada.*Stop following$/u }).click();
  await expect(following.getByRole("button", { name: /^Ada.*Follow$/u })).toBeVisible();
  await closeSheet(bea, "People");

  // Ada moves the Gate note to Crypt: the place, and Bea's star, go with it.
  await onBoard(ada, "Gate").click();
  await onBoard(ada, "Gate").click({ button: "right" });
  await ada.getByRole("menuitem", { name: "Move to page" }).click();
  await ada.getByRole("menuitem", { name: "Crypt" }).click();
  await expect(pageButton(ada)).toHaveText("Crypt");
  const moved = await openSheet(bea, "Places");
  await expect(moved.getByRole("listitem").first()).toContainText("GateCryptMy place");
  await closeSheet(bea, "Places");

  // Ada deletes Crypt while Bea is on it: Bea lands on Town and is told why,
  // and the places on Crypt are gone with it.
  await goToPage(bea, "Crypt");
  await pageItemAction(ada, "Crypt", "Delete");
  const notice = bea.getByText("“Crypt” was deleted. You are now on “Town”.", { exact: true });
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(pageButton(bea)).toHaveText("Town");
  await shot(bea, "deleted-notice");
  const after = await openSheet(bea, "Places");
  await expect(
    after.getByText("No places yet. Select something on the board and add it to places."),
  ).toBeVisible();
  await closeSheet(bea, "Places");

  // The last page has no way to be deleted.
  const list = await openPages(ada);
  await list.getByTestId("page-menu.item").getByTestId("page-menu.item-submenu").click();
  await expect(ada.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(ada.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);

  await expectNoCspViolations(ada);
  await expectNoCspViolations(bea);
  await bea.context().close();
  await desk.close();
});

// table.tldr (three pages) with `extra` more empty pages after its own.
function withExtraPages(extra: number): Buffer {
  const file = JSON.parse(readFileSync(fixture("table.tldr"), "utf8")) as { records: object[] };
  const digits = "456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  for (let at = 0; at < extra; at++) {
    file.records.push({
      id: `page:extra-${at}`,
      index: `a${digits[at]}`,
      meta: {},
      name: `Extra ${at + 1}`,
      typeName: "page",
    });
  }
  return Buffer.from(JSON.stringify(file));
}

async function openTldrBytes(page: Page, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("main-menu.button").click();
  await page.getByRole("menuitem", { name: "Open a .tldr file…" }).click();
  const picker = await chooser;
  await picker.setFiles({ buffer, mimeType: "", name: "many.tldr" });
}

test("a .tldr's pages join the page menu and the places list, up to the page cap", async ({
  page,
}) => {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Ivo`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await putNote(page, { at: { x: 300, y: 300 }, text: "Ours" });

  await openTldr(page, "table.tldr");
  await expect(toast(page, "The file's pages were added to the board.")).toBeVisible();
  await expect(pageButton(page)).toHaveText("The map");
  expect(await pagesListed(page)).toEqual(["Page 1", "The map", "The table", "Notes"]);
  await closePages(page);
  const places = await openSheet(page, "Places");
  await expect(
    places.getByRole("button", { exact: true, name: "The hall The table" }),
  ).toBeVisible();
  await expect(places.getByRole("button", { exact: true, name: "The map The map" })).toBeVisible();
  await places.getByRole("button", { exact: true, name: "The hall The table" }).click();
  await expect(places).toBeHidden();
  await expect(pageButton(page)).toHaveText("The table");

  // The download carries the board's own page as well as the file's.
  const exported = documentOf(await downloadTldr(page));
  expect(exported.pages.map((one) => one.name)).toEqual([
    "Page 1",
    "The map",
    "The table",
    "Notes",
  ]);

  // 4 pages + 37 would pass tldraw's 40: the whole file is refused, and no
  // image of it is uploaded.
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/files"))
      uploads.push(request.url());
  });
  await openTldrBytes(page, withExtraPages(34));
  await expect(
    toast(page, "This file has too many pages. The board has room for 36 more, up to 40 in all."),
  ).toBeVisible();
  expect(uploads).toEqual([]);
  expect(await pagesListed(page)).toHaveLength(4);
  await closePages(page);

  // 36 fill the board to the cap exactly.
  await openTldrBytes(page, withExtraPages(33));
  await expect(toast(page, "The file's pages were added to the board.").first()).toBeVisible();
  await expect.poll(async () => pagesListed(page)).toHaveLength(40);
  await closePages(page);
  await expectNoCspViolations(page);
});
