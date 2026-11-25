import { type Browser, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

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
  reviewShot,
} from "./helpers";
import { documentOf, downloadTldr, fixture, openTldr, toast } from "./tldr";

const DESKTOP = { ...devices["Desktop Chrome"], deviceScaleFactor: 2 };
const phoneAt = (width: number) => ({
  ...PHONE,
  deviceScaleFactor: 2,
  viewport: { height: 844, width },
});

async function shot(page: Page, name: string): Promise<void> {
  await reviewShot(page, `pages-${name}`);
}

const pageButton = (page: Page) => page.getByTestId("page-menu.button");

const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;

// WARNING: Use touch on mobile so tldraw sees a coarse pointer.
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

// WARNING: Press Escape only while a menu is open so tldraw routes it to the menu rather than the canvas.
async function closeMenus(page: Page): Promise<void> {
  const list = page.getByTestId("page-menu.list");
  await expect(async () => {
    if (await list.isVisible()) await page.keyboard.press("Escape");
    await expect(list).toBeHidden({ timeout: 500 });
  }).toPass();
}

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

// WARNING: tldraw prompts for the name on phones instead of opening the desktop inline field.
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

test("a connected guest receives the latest summon while the editor is still loading", async ({
  browser,
  page: owner,
}) => {
  await owner.goto(`${HOST}/sign-in?name=Ada`);
  await owner.getByRole("button", { name: "New board" }).click();
  await expect(pageButton(owner)).toHaveText("Page 1");
  await putNote(owner, { at: { x: 320, y: 260 }, text: "A note on the starting page" });

  await openPages(owner);
  await owner.getByTestId("page-menu.create").click();
  const name = owner.getByTestId("page-menu.list").getByRole("textbox");
  await name.fill("First destination");
  await name.press("Enter");
  await owner.getByTestId("page-menu.create").click();
  await name.fill("Latest destination");
  await name.press("Enter");
  await closePages(owner);
  await goToPage(owner, "First destination");

  const guest = await browser.newPage(DESKTOP);
  const allowFonts = Promise.withResolvers<null>();
  await guest.route("**/*.woff2", async (route) => {
    await allowFonts.promise;
    await route.continue();
  });
  try {
    const connecting = guest.waitForEvent("websocket", (socket) =>
      new URL(socket.url()).pathname.endsWith("/connect"),
    );
    await guest.goto(owner.url(), { waitUntil: "commit" });
    await guest.getByLabel("Your name").fill("Bea");
    await guest.getByRole("button", { name: "Join the board" }).click();
    const socket = await connecting;
    const receiveSummon = () =>
      socket.waitForEvent("framereceived", ({ payload }) => payload.includes('"type":"summon"'));

    const people = await openSheet(owner, "People");
    await expect(people.getByRole("button", { name: /^Bea/u })).toBeVisible();
    await expect(pageButton(guest)).toHaveCount(0);
    const summon = people.getByRole("button", { name: "Summon everyone" });
    await Promise.all([receiveSummon(), summon.click()]);
    await expect(people.getByRole("status")).toHaveText("Summon sent.");
    await closeSheet(owner, "People");
    await goToPage(owner, "Latest destination");
    await openSheet(owner, "People");
    await Promise.all([receiveSummon(), summon.click()]);
    await expect(people.getByRole("status")).toHaveText("Summon sent.");
    await expect(pageButton(guest)).toHaveCount(0);

    allowFonts.resolve(null);
    await expect(pageButton(guest)).toHaveText("Latest destination");
  } finally {
    allowFonts.resolve(null);
    await guest.close();
  }
});

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

  await putNote(ada, { at: { x: 300, y: 300 }, text: "Gate" });
  const adaPlaces = await openSheet(ada, "Search");
  await adaPlaces.getByRole("button", { name: "Add to places" }).click();
  await adaPlaces.getByLabel("Place name").fill("Gate");
  await adaPlaces.getByRole("button", { name: "Save" }).click();
  await expect(adaPlaces.getByRole("button", { exact: true, name: "Gate" })).toBeVisible();
  await closeSheet(ada, "Search");

  await openPages(ada);
  await ada.getByTestId("page-menu.create").click();
  const field = ada.getByTestId("page-menu.list").getByRole("textbox");
  await field.fill("Crypt");
  await field.press("Enter");
  await expect(pageButton(ada)).toHaveText("Crypt");
  await closePages(ada);
  await expect.poll(async () => pagesListed(bea)).toEqual(["Page 1", "Crypt"]);
  await closePages(bea);

  await Promise.all([
    renamePage(bea, { from: "Page 1", to: "Town" }),
    renamePage(ada, { from: "Crypt", to: "Vault" }),
  ]);
  await expect.poll(async () => pagesListed(ada)).toEqual(["Town", "Vault"]);
  await expect.poll(async () => pagesListed(bea)).toEqual(["Town", "Vault"]);
  // WARNING: tldraw closes an open page menu on a synced page update. Open both menus before issuing the concurrent edits.
  const moveUp = ada.getByRole("menuitem", { name: "Move up" });
  const moveDown = bea.getByRole("menuitem", { name: "Move down" });
  await expect(async () => {
    for (const screen of [ada, bea]) await closeMenus(screen);
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

  await goToPage(ada, "Town");
  await ada.reload();
  await expect(pageButton(ada)).toHaveText("Town");
  expect(await pagesListed(ada)).toEqual(["Crypt", "Town"]);
  await shot(ada, "desktop-menu");
  await closePages(ada);

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

  await goToPage(ada, "Crypt");
  await putNote(ada, { at: { x: 1100, y: 250 }, text: "Altar" });
  const placesOnCrypt = await openSheet(ada, "Search");
  await placesOnCrypt.getByRole("button", { name: "Add to places" }).click();
  await placesOnCrypt.getByLabel("Place name").fill("Altar");
  await placesOnCrypt.getByRole("button", { name: "Save" }).click();
  await closeSheet(ada, "Search");
  const beaPlaces = await openSheet(bea, "Search");
  const altar = beaPlaces.getByRole("button", { exact: true, name: "Altar Crypt" });
  await expect(altar).toBeVisible();
  await expect(beaPlaces.getByRole("button", { exact: true, name: "Gate Town" })).toBeVisible();
  await beaPlaces.getByRole("button", { name: "My place: Gate" }).click();
  await expect(beaPlaces.getByRole("listitem").first()).toContainText("GateTownMy place");
  await shot(bea, "places-two-pages");
  await altar.click();
  await expect(pageButton(bea)).toHaveText("Crypt");
  await expect(onBoard(bea, "Altar")).toBeInViewport();

  await goToPage(ada, "Town");
  const gate = await openSheet(ada, "Search");
  await gate.getByRole("button", { exact: true, name: "Gate Town" }).click();
  await expect(onBoard(ada, "Gate")).toBeInViewport();
  const ownerPeople = await openSheet(ada, "People");
  const summon = ownerPeople.getByRole("button", { name: "Summon everyone" });
  await expect(summon).toBeEnabled();
  await summon.click();
  await expect(ownerPeople.getByRole("status")).toHaveText("Summon sent.");
  await expect(pageButton(bea)).toHaveText("Town");
  await expect(onBoard(bea, "Gate")).toBeInViewport();
  await shot(ada, "owner-summon");
  await closeSheet(ada, "People");
  await goToPage(bea, "Crypt");

  const people = await openSheet(bea, "People");
  await expect(people.getByRole("button", { name: "Summon everyone" })).toHaveCount(0);
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

  await onBoard(ada, "Gate").click();
  await onBoard(ada, "Gate").click({ button: "right" });
  await ada.getByRole("menuitem", { name: "Move to page" }).click();
  await ada.getByRole("menuitem", { name: "Crypt" }).click();
  await expect(pageButton(ada)).toHaveText("Crypt");
  const moved = await openSheet(bea, "Search");
  await expect(moved.getByRole("listitem").first()).toContainText("GateCryptMy place");
  await closeSheet(bea, "Search");

  await goToPage(bea, "Crypt");
  await pageItemAction(ada, "Crypt", "Delete");
  const notice = bea.getByText("“Crypt” was deleted. You are now on “Town”.", { exact: true });
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(pageButton(bea)).toHaveText("Town");
  await shot(bea, "deleted-notice");
  const after = await openSheet(bea, "Search");
  await expect(
    after.getByText("No places yet. Select something on the board and add it to places."),
  ).toBeVisible();
  await closeSheet(bea, "Search");

  const list = await openPages(ada);
  await list.getByTestId("page-menu.item").getByTestId("page-menu.item-submenu").click();
  await expect(ada.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(ada.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);

  await expectNoCspViolations(ada);
  await expectNoCspViolations(bea);
  await bea.context().close();
  await desk.close();
});

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
  await page.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
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
  const places = await openSheet(page, "Search");
  await expect(
    places.getByRole("button", { exact: true, name: "The hall The table" }),
  ).toBeVisible();
  await expect(places.getByRole("button", { exact: true, name: "The map The map" })).toBeVisible();
  await places.getByRole("button", { exact: true, name: "The hall The table" }).click();
  await expect(places).toBeHidden();
  await expect(pageButton(page)).toHaveText("The table");

  const exported = documentOf(await downloadTldr(page));
  expect(exported.pages.map((one) => one.name)).toEqual([
    "Page 1",
    "The map",
    "The table",
    "Notes",
  ]);

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

  await openTldrBytes(page, withExtraPages(33));
  await expect(toast(page, "The file's pages were added to the board.").first()).toBeVisible();
  await expect.poll(async () => pagesListed(page)).toHaveLength(40);
  await closeMenus(page);
  await expectNoCspViolations(page);
});
