import type { Editor, TLArrowShape, TLShapeId } from "tldraw";

import { expect, test } from "@playwright/test";
import { createShapeId } from "@tldraw/tlschema";

import { boardAt, socketOf, STANDALONE } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  expectOwnPolicy,
  joinAs,
  onBoard,
  openSheet,
  phone,
  PHONE,
  putNote,
  reachEditor,
  reviewShot,
  rollTwoD6,
  sheet,
} from "./helpers";

// Standalone mode: the tabletop is its own host. The owner signs
// in through e2e/fake-workos.ts (the hosted AuthKit page's stand-in),
// makes a board on the front page, and a guest joins by its link with only
// a name. Nothing leaves the machine.

const ON_BOARD = boardAt(STANDALONE);

test("the board menu and right-hand controls share guides on public and private boards", async ({
  browser,
  page,
}) => {
  const landing = await phone(browser, `${STANDALONE}/`);
  await landing.getByTestId("page-menu.button").waitFor();
  const landingMenu = (await landing.locator(".tlui-menu-zone").boundingBox())!;

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Layout owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  const toggle = page.getByRole("button", { name: "Secret layer" });
  await expect(toggle).toBeEnabled();

  const menu = page.locator(".tlui-menu-zone:visible");
  const tools = page.getByRole("toolbar", { exact: true, name: "Tools" });
  const ownerMenu = (await menu.boundingBox())!;
  const ownerTools = (await tools.boundingBox())!;
  const ownerToggle = (await toggle.boundingBox())!;
  expect(ownerMenu.x).toBe(landingMenu.x);
  expect(ownerMenu.y).toBe(landingMenu.y);
  expect(ownerMenu.height).toBe(landingMenu.height);
  expect(ownerMenu.x).toBeCloseTo(ownerTools.x, 0);
  expect(ownerMenu.y).toBe(ownerToggle.y);
  expect(ownerMenu.height).toBe(ownerToggle.height);
  expect(ownerToggle.width).toBe(ownerToggle.height);

  const guest = await phone(browser, page.url());
  await joinAs(guest, "Layout guest");
  const guestMenu = (await guest.locator(".tlui-menu-zone").boundingBox())!;
  expect(guestMenu).toMatchObject({
    height: landingMenu.height,
    x: landingMenu.x,
    y: landingMenu.y,
  });

  await page.setViewportSize({ height: 900, width: 1200 });
  const styles = page.locator(".tlui-style-panel__wrapper:visible");
  await expect(styles).toBeVisible();
  const desktopMenu = (await menu.boundingBox())!;
  const desktopToggle = (await toggle.boundingBox())!;
  const desktopStyles = (await styles.boundingBox())!;
  expect(desktopMenu.y).toBe(desktopToggle.y);
  expect(desktopStyles.y).toBeGreaterThan(desktopToggle.y + desktopToggle.height);
  expect(desktopStyles.x + desktopStyles.width).toBeCloseTo(
    desktopToggle.x + desktopToggle.width,
    0,
  );

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.y).toBe(desktopMenu.y);

  await guest.context().close();
  await landing.context().close();
});

test("the landing introduction keeps its typography and position when the board opens", async ({
  page,
}) => {
  await page.setViewportSize(PHONE.viewport);
  const release = Promise.withResolvers<void>();
  await page.route("**/api/public-board/bootstrap", async (route) => {
    await release.promise;
    await route.continue();
  });
  const font = Promise.withResolvers<void>();
  await page.route("**/Shantell_Sans-Informal_Regular-*.woff2", async (route) => {
    await font.promise;
    await route.continue();
  });

  await page.goto(STANDALONE, { waitUntil: "commit" });
  const preview = page.locator("[data-landing-preview]");
  try {
    await expect(page.getByRole("status")).toBeAttached();
    await expect(preview).toBeInViewport();
    const box = await preview.boundingBox();
    const family = await preview.evaluate((note) => getComputedStyle(note).fontFamily);
    release.resolve();
    font.resolve();
    const live = page.locator("[data-public-board-note]");
    await expect(live).toBeInViewport();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(live).toHaveCSS("font-family", family);
    expect(await live.boundingBox()).toEqual(box);
    await expect(preview).toHaveCount(0);
  } finally {
    release.resolve();
    font.resolve();
  }
});

test("the home page is one editable public board for anonymous visitors", async ({
  browser,
  page,
}) => {
  await page.goto(`${STANDALONE}/`);
  const guest = await phone(browser, `${STANDALONE}/`);

  const intro = guest.locator(".tl-background__wrapper").getByRole("region", {
    name: "Public whiteboard",
  });
  const firstParagraph = intro.locator("p").first();
  await expect(firstParagraph).toBeInViewport();
  await expect(intro.getByRole("heading")).toHaveCount(0);
  await expect(intro.getByText("Little Table is this app.", { exact: false })).toBeInViewport();
  await expect(intro).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(intro).toHaveCSS("padding", "0px 2px");
  for (const text of [firstParagraph, intro.locator("footer")]) {
    await expect(text).toHaveCSS("font-size", "15px");
  }
  await expect
    .poll(async () => {
      const note = await intro.boundingBox();
      const menu = await guest.getByRole("button", { exact: true, name: "Menu" }).boundingBox();
      return note !== null && menu !== null && Math.abs(note.x - menu.x) <= 1;
    })
    .toBe(true);
  await expect(guest.getByRole("button", { exact: true, name: "Landing Page" })).toBeVisible();
  await expect(guest.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(guest.getByLabel("Your name")).toHaveCount(0);

  await putNote(page, { at: { x: 200, y: 648 }, text: "A note from the public board" });
  await expect(onBoard(guest, "A note from the public board")).toBeInViewport();
  await expectNoCspViolations(guest);
  await guest.context().close();
});

test("two guests can chat live and see their messages after reloading", async ({
  browser,
  page,
}) => {
  await page.goto(`${STANDALONE}/`);
  const guest = await phone(browser, `${STANDALONE}/`);
  try {
    const desktopChat = await openSheet(page, "Chat");
    const phoneChat = await openSheet(guest, "Chat");
    for (const chat of [desktopChat, phoneChat]) {
      await expect(chat.getByText("Loading messages…")).toBeHidden();
    }

    const question = "Can I borrow a pencil?";
    const reply = "There is one next to the map.";
    const phoneMessage = phoneChat.getByRole("textbox", { exact: true, name: "Message" });
    await phoneMessage.fill(question);
    await phoneChat.getByRole("button", { exact: true, name: "Send" }).click();
    await expect(desktopChat.getByRole("log").getByText(question, { exact: true })).toBeVisible();
    await expect(phoneMessage).toHaveValue("");

    const desktopMessage = desktopChat.getByRole("textbox", { exact: true, name: "Message" });
    await desktopMessage.fill(reply);
    await desktopMessage.press("Enter");
    await expect(phoneChat.getByRole("log").getByText(reply, { exact: true })).toBeVisible();
    for (const chat of [desktopChat, phoneChat]) {
      await expect(chat.getByRole("log").getByText(question, { exact: true })).toHaveCount(1);
      await expect(chat.getByRole("log").getByText(reply, { exact: true })).toHaveCount(1);
    }

    await guest.reload();
    const reopened = await openSheet(guest, "Chat");
    const history = reopened.getByRole("log");
    await expect(history.getByText(question, { exact: true })).toBeVisible();
    await expect(history.getByText(reply, { exact: true })).toBeVisible();
    await expectNoCspViolations(guest);
  } finally {
    await guest.context().close();
  }
});

test("a public arrow saves its moved endpoint for the expiry sweep", async ({ page }) => {
  await page.goto(`${STANDALONE}/`);
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await reachEditor(page);
  const ids = { arrow: String(createShapeId()), target: String(createShapeId()) };
  await page.evaluate(({ arrow, target }) => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    editor.createShapes([
      { id: target as TLShapeId, props: { h: 100, w: 100 }, type: "geo", x: 320, y: 100 },
      { id: arrow as TLShapeId, props: { end: { x: 250, y: 50 } }, type: "arrow", x: 20, y: 100 },
    ]);
    editor.createBinding({
      fromId: arrow as TLShapeId,
      props: { terminal: "end" },
      toId: target as TLShapeId,
      type: "arrow",
    });
  }, ids);
  const rememberedEnd = () =>
    page.evaluate((arrow) => {
      const editor = (globalThis as unknown as { __editor: Editor }).__editor;
      const point = editor.getShape<TLArrowShape>(arrow as TLShapeId)?.meta.littleTableArrowEnd;
      return (point as { x?: number } | undefined)?.x;
    }, ids.arrow);
  await expect.poll(rememberedEnd).toEqual(expect.any(Number));
  const initial = (await rememberedEnd())!;
  await page.evaluate((target) => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    editor.updateShape({ id: target as TLShapeId, type: "geo", x: 500 });
  }, ids.target);
  await expect.poll(rememberedEnd).toBeGreaterThan(initial);
});

test("a board created in Polish opens with Strona 1 for its first guest in English", async ({
  browser,
  page,
}) => {
  await page.goto(`${STANDALONE}/boards?lang=pl`);
  await page.getByRole("link", { name: "Zaloguj się" }).click();
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();

  // Stop the creator's navigation from loading the canvas so the guest opens the room first.
  await page.route(`${STANDALONE}/b/*`, (route) => route.fulfill({ body: "" }), { times: 1 });
  await page.getByRole("button", { name: "Nowa tablica" }).click();
  await expect(page).toHaveURL(ON_BOARD);

  const context = await browser.newContext({
    ...PHONE,
    colorScheme: "dark",
    locale: "en-US",
    viewport: { height: 844, width: 390 },
  });
  try {
    const guest = await context.newPage();
    await guest.goto(page.url());
    const join = guest.getByRole("button", { name: "Join the board" });
    await expect(join).toBeDisabled();
    await expect(join).toHaveCSS("background-image", "none");
    await expect(join).toHaveCSS("opacity", "1");
    await reviewShot(guest, "standalone-dark-guest-name-disabled");

    await guest.getByLabel("Your name").fill("Bea");
    await expect(join).toBeEnabled();
    await expect(join).not.toHaveCSS("background-image", "none");
    await reviewShot(guest, "standalone-dark-guest-name-enabled");
    await join.click();
    await expect(guest.getByTestId("page-menu.button")).toHaveText("Strona 1");
  } finally {
    await context.close();
  }
});

test("an owner signs in and makes a board; a guest joins by link and plays", async ({
  browser,
  page,
}) => {
  await collectCspViolations(page);

  await page.goto(`${STANDALONE}/`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Signed in as Ada Lovelace", { exact: true })).toBeVisible();
  await expect(page.getByText("No boards yet.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);
  const boardUrl = page.url();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expectOwnPolicy(page, `'self' ${socketOf(STANDALONE)};`);

  // The guest, on a phone, has no account and needs none.
  const guest = await phone(browser, boardUrl);
  await joinAs(guest, "Bea");

  await putNote(page, { at: { x: 200, y: 300 }, text: "Hello table" });
  await expect(onBoard(guest, "Hello table")).toBeVisible();
  await rollTwoD6(guest, page, "Bea");

  // The owner makes a place of a note off the guest's small screen; the
  // guest jumps to it.
  await putNote(page, { at: { x: 1100, y: 250 }, text: "The map" });
  const places = await openSheet(page, "Search");
  await places.getByRole("button", { name: "Add to places" }).click();
  await places.getByLabel("Place name").fill("The map");
  await places.getByRole("button", { name: "Save" }).click();
  await expect(places.getByRole("button", { exact: true, name: "The map" })).toBeVisible();
  await closeSheet(page, "Search");
  const farNote = onBoard(guest, "The map");
  await expect(farNote).not.toBeInViewport();
  const guestPlaces = await openSheet(guest, "Search");
  await guestPlaces.getByRole("button", { exact: true, name: "The map" }).click();
  await expect(sheet(guest, "Search")).toBeHidden();
  await expect(farNote).toBeInViewport();

  // From the front page the owner renames the board and resets its link;
  // the guest, who has only the old link, is put out.
  const front = await page.context().newPage();
  await collectCspViolations(front);
  await front.goto(`${STANDALONE}/boards`);
  const row = front.getByRole("listitem").filter({ hasText: "Board" });
  await row.getByLabel(/^Manage /u).click();
  await row.getByRole("button", { name: "Rename" }).click();
  await row.getByLabel("Board name").fill("Mörk Borg night");
  await row.getByRole("button", { name: "Save" }).click();
  const renamed = front.getByRole("listitem").filter({ hasText: "Mörk Borg night" });
  await renamed.getByLabel("Manage Mörk Borg night", { exact: true }).click();
  await renamed.getByRole("button", { name: "Reset link" }).click();
  await renamed.getByRole("alertdialog").getByRole("button", { name: "Reset link" }).click();
  await expect(
    guest.getByText("The board's link was reset. Ask its creator for the new one."),
  ).toBeVisible();
  const link = front.getByRole("link", { name: "Mörk Borg night" });
  // NOTE: the list shows the new link once the reset's answer is in.
  await expect(link).not.toHaveAttribute("href", new URL(boardUrl).pathname);
  const newLink = await link.getAttribute("href");

  await page.goto(`${STANDALONE}${newLink}`);
  await expect(onBoard(page, "Hello table")).toBeVisible();
  await expect(page).toHaveTitle("Mörk Borg night");

  await front.getByLabel("Signed in as Ada Lovelace", { exact: true }).click();
  await front.getByRole("button", { name: "Sign out" }).click();
  await expect(front).toHaveURL(`${STANDALONE}/`);
  await expect(front.getByRole("link", { name: "Sign in" })).toBeVisible();
  await front.goto(`${STANDALONE}/boards`);
  await expect(front.getByRole("link", { name: "Sign in" })).toBeVisible();

  await expectNoCspViolations(page);
  await expectNoCspViolations(front);
  await expectNoCspViolations(guest);
  await guest.context().close();
});
