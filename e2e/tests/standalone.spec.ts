import type { Editor, TLArrowShape, TLShapeId } from "tldraw";

import { expect, test } from "@playwright/test";
import { createShapeId } from "@tldraw/tlschema";
import { execFileSync } from "node:child_process";

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

const ON_BOARD = boardAt(STANDALONE);

test("explains a server failure when the landing board cannot open", async ({ page }) => {
  const bootstrap = "**/api/public-board/bootstrap";
  await page.route(bootstrap, (route) => route.fulfill({ status: 500 }));
  await page.route(
    bootstrap,
    (route) => route.fulfill({ json: { error: "daily-server-limit" }, status: 503 }),
    { times: 1 },
  );

  await page.goto(STANDALONE);
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText(
    "Little Table reached its daily server limit. Try again after 00:00 UTC.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toHaveText("The board server is unavailable. Try again in a moment.");
});

declare global {
  var __editor: Editor;
}

test("board sections collapse on phones only when both lists have three boards", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${STANDALONE}/boards?lang=en`);
  await page.getByRole("link", { name: "Sign in" }).click();
  const account = crypto.randomUUID().slice(0, 12);
  await page.getByLabel("Name").fill(`Board lists ${account}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${STANDALONE}/boards`);

  const start = await request.get(`${STANDALONE}/auth/sign-in?return=/boards`, { maxRedirects: 0 });
  const authorize = new URL(start.headers().location!);
  authorize.searchParams.set("fake_user", `Board host ${account}`);
  const signedIn = await request.get(authorize.href);
  expect(signedIn.url()).toBe(`${STANDALONE}/boards`);
  const member = page.request;
  const headersFor = async (client: typeof member) => {
    const response = await client.get(`${STANDALONE}/api/me`);
    const me = await response.json();
    return { Origin: STANDALONE, "X-CSRF-Token": me.csrf };
  };
  const memberHeaders = await headersFor(member);
  const hostHeaders = await headersFor(request);
  const shared: { id: string; shareCode: string }[] = [];
  for (let index = 0; index < 3; index++) {
    const own = await member.post(`${STANDALONE}/api/boards`, {
      data: { title: `Created ${index}` },
      headers: memberHeaders,
    });
    expect(own.status()).toBe(201);
    const board = await request.post(`${STANDALONE}/api/boards`, {
      data: { title: `Joined ${index}` },
      headers: hostHeaders,
    });
    expect(board.status()).toBe(201);
    shared.push(await board.json());
  }
  const visit = async (index: number) => {
    const response = await member.post(
      `${STANDALONE}/api/b/${shared[index]!.shareCode}/bootstrap`,
      { data: {}, headers: memberHeaders },
    );
    expect(response.ok()).toBe(true);
  };
  await visit(0);
  await visit(1);
  await page.reload();
  const created = page.getByRole("button", { exact: true, name: "Boards created" });
  const joined = page.getByRole("button", { exact: true, name: "Boards joined" });
  const row = page.getByRole("link", { exact: true, name: "Joined 0" });
  await expect(row).toBeVisible();
  await expect(created.or(joined)).toHaveCount(0);

  await visit(2);
  await page.reload();
  await expect(created).toHaveAttribute("aria-expanded", "true");
  await expect(joined).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("main h2")).toHaveText(["Boards created", "Boards joined"]);
  await joined.press("Enter");
  await expect(joined).toHaveAttribute("aria-expanded", "false");
  await expect(row).toBeHidden();
  await expect(created).toHaveAttribute("aria-expanded", "true");
  await reviewShot(page, "boards-collapsible-phone");
  await joined.press("Space");
  await expect(row).toBeVisible();

  await page.setViewportSize({ height: 900, width: 1200 });
  await expect(created.or(joined)).toHaveCount(0);
  await expect(row).toBeVisible();

  for (const board of shared) {
    const removed = await request.post(`${STANDALONE}/api/boards/${board.id}/delete`, {
      data: {},
      headers: hostHeaders,
    });
    expect(removed.status()).toBe(204);
  }
  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload();
  await expect(page.getByRole("link", { exact: true, name: "Created 0" })).toBeVisible();
  await expect(created.or(joined)).toHaveCount(0);
});

test("a board thumbnail warms the shared editor and opens its board", async ({ page }) => {
  const start = await page.request.get(`${STANDALONE}/auth/sign-in?return=/boards`, {
    maxRedirects: 0,
  });
  const authorize = new URL(start.headers().location!);
  authorize.searchParams.set("fake_user", `Board links ${crypto.randomUUID()}`);
  await page.request.get(authorize.href);
  const account = await page.request.get(`${STANDALONE}/api/me`);
  const me = await account.json();
  for (const title of ["Created 0", "Created 1"]) {
    const response = await page.request.post(`${STANDALONE}/api/boards`, {
      data: { title },
      headers: { Origin: STANDALONE, "X-CSRF-Token": me.csrf },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(`${STANDALONE}/boards`);

  const firstBoard = page.getByRole("link", { name: "Created 0", exact: true });
  const thumbnail = page
    .getByRole("listitem")
    .filter({ has: firstBoard })
    .locator("span[aria-hidden=true]")
    .first();
  const box = await thumbnail.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const editor = page.waitForResponse(/\/assets\/board-[^/]+\.js$/u);
  await page.mouse.move(x, y);
  const editorResponse = await editor;
  expect(editorResponse.ok()).toBe(true);
  const warmed = page.locator('head > link[rel="modulepreload"][href*="/board-"]');
  await expect(warmed).toHaveCount(1);
  await page.getByRole("link", { name: "Created 1", exact: true }).focus();
  await expect(warmed).toHaveCount(1);
  await expect(page).toHaveURL(`${STANDALONE}/boards`);
  const target = await firstBoard.getAttribute("href");
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(`${STANDALONE}${target}`);
});

test("landing header controls fit narrow phones before and after sign-in", async ({ browser }) => {
  const landing = await phone(browser, `${STANDALONE}/`);
  const github = landing.getByRole("link", { name: "Source code on GitHub" });
  const pageMenu = landing.getByTestId("page-menu.button");
  const menu = landing.locator(".tlui-menu-zone");
  const chat = landing.getByRole("button", { name: "Chat" });

  const expectHeader = async (account: "Sign in" | "My boards", state: string) => {
    await expect(github).toHaveAttribute("href", "https://github.com/hasparus/littletable.top");
    await expect(pageMenu).toHaveAccessibleName("Landing Page");
    for (const width of [320, 360]) {
      await landing.setViewportSize({ height: 800, width });
      const menuBox = (await menu.boundingBox())!;
      const chatBox = (await chat.boundingBox())!;
      expect(chatBox.x).toBeGreaterThan(menuBox.x + menuBox.width);
      await expect(github).toBeInViewport({ ratio: 1 });
      await expect(landing.getByRole("link", { name: account })).toBeInViewport({ ratio: 1 });
      await reviewShot(landing, `landing-github-${state}-${width}`);
    }
  };

  try {
    await expectHeader("Sign in", "guest");
    await landing.getByRole("link", { name: "Sign in" }).click();
    await landing.getByLabel("Name").fill("Landing header member");
    await landing.getByRole("button", { name: "Continue" }).click();
    await landing.waitForURL(`${STANDALONE}/boards`);
    await landing.goto(`${STANDALONE}/`);
    await expectHeader("My boards", "member");
  } finally {
    await landing.context().close();
  }
});

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

  const longName = "The Sunken Cathedral of Ys, lower floor";
  await reachEditor(page);
  await page.evaluate(
    (name) => globalThis.__editor.renamePage(globalThis.__editor.getCurrentPageId(), name),
    longName,
  );
  const pageMenu = (await page.getByRole("button", { name: longName }).boundingBox())!;
  expect(pageMenu.x + pageMenu.width).toBeLessThanOrEqual((await toggle.boundingBox())!.x);

  const guest = await phone(browser, page.url());
  await joinAs(guest, "Layout guest");
  const guestMenu = (await guest.locator(".tlui-menu-zone").boundingBox())!;
  expect(guestMenu).toMatchObject({
    height: landingMenu.height,
    x: landingMenu.x,
    y: landingMenu.y,
  });

  await page.setViewportSize({ height: 900, width: 1200 });
  const styles = page.getByRole("button", { exact: true, name: "Styles" });
  await expect(styles).toBeVisible();
  const desktopMenu = (await menu.boundingBox())!;
  const desktopToggle = (await toggle.boundingBox())!;
  const desktopChat = (await page
    .getByRole("button", { exact: true, name: "Chat" })
    .boundingBox())!;
  const desktopShare = (await page
    .getByRole("button", { exact: true, name: "Share" })
    .boundingBox())!;
  const desktopStyles = (await styles.boundingBox())!;
  expect(desktopMenu.y).toBe(desktopToggle.y);
  for (const control of [desktopChat, desktopShare]) expect(control.y).toBe(desktopToggle.y);
  expect(desktopChat.x).toBeGreaterThan(desktopToggle.x + desktopToggle.width);
  expect(desktopShare.x).toBeGreaterThan(desktopChat.x + desktopChat.width);
  expect(desktopStyles.y).toBeGreaterThan(desktopToggle.y + desktopToggle.height);
  expect(desktopStyles.x + desktopStyles.width).toBeCloseTo(desktopShare.x + desktopShare.width, 0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.y).toBe(desktopMenu.y);

  await guest.context().close();
  await landing.context().close();
});

test("a desktop shows and hides the styles from one button, as a phone does", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1200 });
  await page.goto(`${STANDALONE}/`);
  const styles = page.getByRole("button", { exact: true, name: "Styles" });
  const red = page.getByRole("radio", { name: /Red/u });
  await expect(styles).toBeVisible();
  await expect(red).toBeHidden();

  await styles.click();
  await red.click();
  await expect(red).toBeChecked();
  await reviewShot(page, "styles-desktop-open");
  await styles.click();
  await expect(red).toBeHidden();
});

test("the landing introduction keeps its typography and position when the board opens", async ({
  page,
}) => {
  await page.setViewportSize(PHONE.viewport);
  const release = Promise.withResolvers<null>();
  await page.route("**/api/public-board/bootstrap", async (route) => {
    await release.promise;
    await route.continue();
  });
  const font = Promise.withResolvers<null>();
  await page.route("**/Shantell_Sans-Informal_Regular-*.woff2", async (route) => {
    await font.promise;
    await route.continue();
  });

  const documentResponse = await page.goto(STANDALONE, { waitUntil: "commit" });
  expect(await documentResponse?.text()).toContain("<section data-landing-preview");
  const preview = page.locator("[data-landing-preview]");
  try {
    await expect(page.getByRole("status")).toBeAttached();
    await expect(preview).toBeHidden();
    font.resolve(null);
    await expect(preview).toBeVisible();
    const session = await page.context().newCDPSession(page);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    async function expectHandwriting(selector: string) {
      const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts).toHaveLength(1);
      expect(fonts[0]?.familyName).toMatch(/Shantell/i);
      expect(fonts[0]?.isCustomFont).toBe(true);
    }
    await expectHandwriting("[data-landing-preview] p");
    await expect(preview).toBeInViewport();
    const box = await preview.boundingBox();
    release.resolve(null);
    const live = page.locator("[data-public-board-note]");
    await expect(live).toBeInViewport();
    await page.evaluate(() => document.fonts.ready.then(() => null));
    await expectHandwriting("[data-public-board-note] p");
    expect(await live.boundingBox()).toEqual(box);
    await expect(preview).toHaveCount(0);
    const lastParagraph = await live.locator("p").last().textContent();
    expect(lastParagraph?.split("\n").at(-1)).toBe("A virtual tabletop without bloat.");

    const signatureStroke = page
      .locator('[data-shape-id="shape:2fFF6jTHq2tZ-b2tBYic2"] svg path')
      .first();
    await expect(signatureStroke).toBeVisible();
    const signature = await signatureStroke.boundingBox();
    expect(signature!.y).toBeGreaterThan(box!.y + box!.height);
    await reviewShot(page, "landing-signature-phone");

    await page.setViewportSize({ height: 800, width: 920 });
    await expect(page.locator("[data-board-toolbar]")).toHaveAttribute("data-board-toolbar", "");
    expect(await live.boundingBox()).toEqual(box);
    await reviewShot(page, "landing-signature-resized");
  } finally {
    release.resolve(null);
    font.resolve(null);
  }
});

test("the prerendered landing intro uses dark mode before JavaScript runs", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(STANDALONE);
    const intro = page.locator("[data-landing-preview]");
    await expect(intro).toBeVisible();
    await expect(intro).toHaveCSS("color", "rgb(250, 250, 250)");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 10, 10)");
  } finally {
    await context.close();
  }
});

test("the public page menu preserves the landing page and its drawings", async ({
  browser,
  page,
}) => {
  await page.goto(`${STANDALONE}/?lang=en`);
  const pageButton = page.getByTestId("page-menu.button");
  await expect(pageButton).toHaveText("Landing Page");
  const text = "A drawing to keep on the landing page";
  await putNote(page, { at: { x: 540, y: 280 }, text });

  const pageList = page.getByTestId("page-menu.list");
  await pageButton.click();
  await page.getByTestId("page-menu.create").click();
  const name = pageList.getByRole("textbox");
  await name.fill("Another page");
  await name.press("Enter");

  const landing = pageList.getByTestId("page-menu.item").filter({ hasText: "Landing Page" });
  await landing.getByTestId("page-menu.item-submenu").click();
  await page.getByRole("menuitem", { exact: true, name: "Delete" }).click();
  await expect(page.getByText("The landing page can’t be deleted.", { exact: true })).toBeVisible();
  await landing.getByRole("button", { name: "Go to page" }).click();
  await expect(pageButton).toHaveText("Landing Page");
  await expect(onBoard(page, text)).toBeVisible();

  if (!(await pageList.isVisible())) await pageButton.click();
  const other = pageList.getByTestId("page-menu.item").filter({ hasText: "Another page" });
  await other.getByTestId("page-menu.item-submenu").click();
  await page.getByRole("menuitem", { exact: true, name: "Move up" }).click();
  await expect(pageList.getByTestId("page-menu.item").first()).toContainText("Another page");

  const fresh = await browser.newPage();
  try {
    await fresh.goto(`${STANDALONE}/?lang=en`);
    await expect(fresh.getByTestId("page-menu.button")).toHaveText("Landing Page");
    await expect(fresh.locator("[data-public-board-note]")).toBeInViewport();
    await expect(onBoard(fresh, text)).toBeVisible();
  } finally {
    await fresh.close();
  }

  await reachEditor(page);
  const attemptedDeletion = await page.evaluate(() => {
    const editor = globalThis.__editor;
    const landing = editor.getCurrentPageId();
    const drawings = editor.getSortedChildIdsForParent(landing);
    editor.store.remove([...drawings, landing]);
    return { landing: String(landing), wasRemoved: editor.getPage(landing) === undefined };
  });
  expect(attemptedDeletion.wasRemoved).toBe(true);
  await page.waitForFunction((id) => {
    return globalThis.__editor.getPages().some((candidate) => candidate.id === id);
  }, attemptedDeletion.landing);
  await page.reload();
  await expect(pageButton).toHaveText("Landing Page");
  await expect(onBoard(page, text)).toBeVisible();

  if (!(await pageList.isVisible())) await pageButton.click();
  await other.getByTestId("page-menu.item-submenu").click();
  await page.getByRole("menuitem", { exact: true, name: "Delete" }).click();
  if (!(await pageList.isVisible())) await pageButton.click();
  await expect(other).toHaveCount(0);
  await page.reload();
  await expect(pageButton).toHaveText("Landing Page");
  await expect(onBoard(page, text)).toBeVisible();

  await onBoard(page, text).click();
  await page.keyboard.press("Delete");
  await expect(onBoard(page, text)).toHaveCount(0);
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

test("a public shape can acquire a pattern fill after the editor mounts", async ({ page }) => {
  await page.goto(STANDALONE);
  await page.locator("[data-public-board-note]").waitFor();
  await reachEditor(page);
  const id = String(createShapeId());
  try {
    await page.evaluate((id) => {
      const editor = (globalThis as unknown as { __editor: Editor }).__editor;
      editor.createShape({ id: id as TLShapeId, type: "geo" });
      editor.updateShape({ id: id as TLShapeId, props: { fill: "pattern" }, type: "geo" });
    }, id);
    await expect(page.getByTestId("ready-pattern-fill-defs")).toBeAttached();
    await page.reload();
    await expect(page.getByTestId("ready-pattern-fill-defs")).toBeAttached();
  } finally {
    await reachEditor(page);
    await page.evaluate((id) => {
      (globalThis as unknown as { __editor: Editor }).__editor.deleteShape(id as TLShapeId);
    }, id);
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

  // WARNING: Intercept the creator’s first navigation so the guest initializes the room.
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

  const guest = await phone(browser, boardUrl);
  await joinAs(guest, "Bea");

  await putNote(page, { at: { x: 200, y: 300 }, text: "Hello table" });
  await expect(onBoard(guest, "Hello table")).toBeVisible();
  await rollTwoD6(guest, page, "Bea");

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

  const front = await page.context().newPage();
  await collectCspViolations(front);
  await front.goto(`${STANDALONE}/boards`);
  const row = front.getByRole("listitem").filter({ hasText: "Board" });
  const original = row.getByRole("link");
  const position = (await original.boundingBox())!;
  await row.getByLabel(/^Manage /u).click();
  await row.getByRole("button", { name: "Rename" }).click();
  const field = front.getByRole("textbox", { name: "Board name" });
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS("border-top-style", "dashed");
  expect((await field.boundingBox())!.x).toBeCloseTo(position.x);
  await field.fill("Mörk Borg night");
  await field.press("Enter");
  const renamed = front.getByRole("listitem").filter({ hasText: "Mörk Borg night" });
  await renamed.getByLabel("Manage Mörk Borg night", { exact: true }).click();
  await renamed.getByRole("button", { name: "Reset link" }).click();
  await renamed.getByRole("alertdialog").getByRole("button", { name: "Reset link" }).click();
  await expect(
    guest.getByText("The board's link was reset. Ask its creator for the new one."),
  ).toBeVisible();
  const link = front.getByRole("link", { name: "Mörk Borg night" });
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

test("an owner can rename a board from its secret layer", async ({ browser, page }) => {
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Keeper");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);

  const guest = await phone(browser, page.url());
  try {
    await joinAs(guest, "Player");
    await guest.getByRole("button", { exact: true, name: "Menu" }).click();
    await expect(guest.getByRole("menuitem", { name: "Rename board" })).toHaveCount(0);

    const layer = page.getByRole("button", { name: "Secret layer" });
    await layer.click();
    await expect(layer).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { exact: true, name: "Menu" }).click();
    await page.getByRole("menuitem", { name: "Rename board" }).click();
    await page.getByLabel("Board name", { exact: true }).fill("Midnight at the keep");
    await page.getByRole("button", { exact: true, name: "Save" }).click();
    await expect(page).toHaveTitle("Midnight at the keep");
    await expect(layer).toHaveAttribute("aria-pressed", "true");

    await guest.reload();
    await expect(guest).toHaveTitle("Midnight at the keep");
    await page.goto(`${STANDALONE}/boards`);
    await expect(page.getByRole("link", { name: "Midnight at the keep" })).toBeVisible();
  } finally {
    await guest.context().close();
  }
});

test("a signed-in owner grants and revokes an assistant's access by choosing a level", async ({
  page,
}) => {
  await collectCspViolations(page);
  await page.goto(`${STANDALONE}/boards?lang=en`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Assistant Test Owner");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Signed in as Assistant Test Owner", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);

  const me = await page.request.get(`${STANDALONE}/api/me`);
  const { account }: { account: { id: string } } = await me.json();
  const accountId = account.id.replaceAll("'", "''");
  execFileSync("wrangler", [
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    ".wrangler/e2e-standalone",
    "--command",
    `INSERT OR IGNORE INTO assistant_clients (account_id, client_id) VALUES ('${accountId}', 'e2e-assistant')`,
  ]);

  await page.goto(`${STANDALONE}/assistants?lang=en`);
  await expect(page).toHaveTitle(/^Assistants · /u);
  await expect(page.getByRole("heading", { level: 1, name: "Assistants" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client 1" })).toBeVisible();
  const access = page.getByRole("radiogroup", { name: /^Access for Board /u });
  await expect(access.getByRole("radio", { name: "Off" })).toBeChecked();

  const api = `${STANDALONE}/api/assistants`;
  const held = Promise.withResolvers<boolean>();
  await page.route(api, async (route) => {
    await held.promise;
    await route.continue();
  });
  const posted = page.waitForResponse(
    (response) => response.url() === api && response.request().method() === "POST",
  );
  await access.getByRole("radio", { name: "Edit" }).check();
  await expect(access).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status")).toHaveText("Saving…");
  held.resolve(true);
  const saved = await posted;
  expect(saved.status()).toBe(204);
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(access).toHaveAttribute("aria-busy", "false");
  await page.unroute(api);
  await reviewShot(page, "assistant-grant-edit");
  await page.reload();
  await expect(access.getByRole("radio", { name: "Edit" })).toBeChecked();

  const sent: string[] = [];
  const arrived = Promise.withResolvers<boolean>();
  const first = Promise.withResolvers<boolean>();
  await page.route(api, async (route) => {
    sent.push(route.request().postData() ?? "");
    if (sent.length === 1) {
      arrived.resolve(true);
      await first.promise;
    }
    await route.continue();
  });
  await access.getByRole("radio", { name: "Read" }).check();
  await arrived.promise;
  await access.getByRole("radio", { name: "Off" }).check();
  first.resolve(true);
  const row = page.getByRole("listitem").filter({ has: access });
  await expect(row.getByText(/Saved\./u)).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("Saved.");
  expect(sent).toEqual([
    expect.stringContaining('"access":"read"'),
    expect.stringContaining('"access":"off"'),
  ]);
  await page.unroute(api);
  await page.reload();
  await expect(access.getByRole("radio", { name: "Off" })).toBeChecked();

  await page.route(api, (route) => route.fulfill({ json: { error: "csrf" }, status: 403 }));
  await access.getByRole("radio", { name: "Read" }).check();
  await expect(page.getByRole("alert")).toHaveText("That did not work. Try again.");
  await expect(access.getByRole("radio", { name: "Off" })).toBeChecked();
  await page.unroute(api);
  await page.reload();
  await expect(access.getByRole("radio", { name: "Off" })).toBeChecked();

  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto(`${STANDALONE}/assistants?lang=pl`);
  await expect(page.getByRole("heading", { level: 1, name: "Asystenci" })).toBeVisible();
  const polish = page.getByRole("radiogroup", { name: /^Dostęp do tablicy „/u });
  await expect(polish.getByRole("radio", { name: "Brak" })).toBeChecked();
  await expect(polish.getByRole("radio", { name: "Edycja" })).toBeEnabled();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
  await reviewShot(page, "assistant-grants-phone");
  await expectNoCspViolations(page);
  await page.getByRole("link", { name: "Twoje tablice" }).click();
  await expect(page).toHaveURL(`${STANDALONE}/boards`);
});
