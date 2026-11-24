import { type Browser, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { HOST } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  openSheet,
  PHONE,
} from "./helpers";

// The 3D throw on a real board, against e2e/fake-host.ts. What can go wrong
// and is checked here: two screens show different placements; the overlay
// swallows taps meant for the board; the dice outlive their result toast; a logged
// roll animates on load; reduced motion or a missing WebGL2 leaves someone
// without their result; a lost context or a resize leaves a blank tray; the
// page's Content-Security-Policy is broken by the dice code.
// The artifacts are the attached tray screenshots.

const tray = (page: Page): Locator => page.locator("[data-dice-tier]");
const diceCanvas = (page: Page): Locator => tray(page).locator("canvas");
// The result toast; it joins the accessibility tree once the dice settle.
const toast = (page: Page): Locator => page.getByRole("button", { exact: true, name: "Close" });

// NOTE: without animations, so nothing passing over the tray, such as a
// button's fade, can make two shots of the same dice differ.
const shoot = async (target: Locator): Promise<Buffer> =>
  target.screenshot({ animations: "disabled" });

async function shows(target: Locator, expected: Buffer): Promise<boolean> {
  const shot = await shoot(target);
  return shot.equals(expected);
}

async function setVisibility(target: Locator, visibility: string): Promise<void> {
  await target.evaluate((element: HTMLElement, value) => {
    element.style.visibility = value;
  }, visibility);
}

async function startBoard(page: Page): Promise<string> {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Ada`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  return page.url();
}

async function guestOn(browser: Browser, url: string, options = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(url);
  await joinAs(page, "Bea");
  return page;
}

async function fillPool(page: Page, pool: number[]): Promise<Locator> {
  const dice = await openSheet(page, "Dice");
  for (const sides of pool) {
    await dice.getByRole("button", { exact: true, name: `Add d${sides}` }).click();
  }
  return dice;
}

async function roll(page: Page, pool: number[]): Promise<void> {
  const dice = await fillPool(page, pool);
  const before = await dice.getByRole("listitem").count();
  await dice.getByRole("button", { name: /^Roll/u }).click();
  await expect(dice.getByRole("listitem")).toHaveCount(before + 1);
  await closeSheet(page, "Dice");
}

test("a roll lands the same on two screens and leaves with its toast", async ({
  browser,
  page,
}, testInfo) => {
  const boardUrl = await startBoard(page);
  const guest = await guestOn(browser, boardUrl);

  await roll(page, [4, 6, 8, 10, 12, 20, 100]);
  const shots: Buffer[] = [];
  for (const [name, screen] of [
    ["roller", page],
    ["watcher", guest],
  ] as const) {
    await expect(diceCanvas(screen)).toBeVisible();
    await expect(toast(screen)).toBeVisible();
    await expect(toast(screen)).toContainText("Ada");
    // Only the dice: the board under them shows each person the other's cursor.
    await setVisibility(screen.locator(".tl-container"), "hidden");
    const shot = await shoot(tray(screen));
    await testInfo.attach(`tray-${name}.png`, { body: shot, contentType: "image/png" });
    shots.push(shot);
    if (screen === page) {
      await setVisibility(diceCanvas(page), "hidden");
      expect(await shows(tray(page), shot), "dice were drawn").toBe(false);
      await setVisibility(diceCanvas(page), "");
    }
    await setVisibility(screen.locator(".tl-container"), "");
  }
  expect(shots[0]!.equals(shots[1]!), "both screens show the same tray").toBe(true);

  // A tap in the middle of the tray reaches the board under it.
  const reachesBoard = await tray(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && !element.contains(hit) && hit.closest(".tl-container") !== null;
  });
  expect(reachesBoard).toBe(true);

  await toast(page).click();
  await expect(tray(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);

  // The log does not throw again on load.
  await page.reload();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const log = await openSheet(page, "Dice");
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await closeSheet(page, "Dice");
  await expect(tray(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
});

type Box = { height: number; width: number; x: number; y: number };

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const boxOf = async (target: Locator): Promise<Box> => (await target.boundingBox())!;

// tldraw's top-left controls: the main menu, the page menu, and on a wide
// screen undo, redo and the rest.
const menuZone = (page: Page): Locator => page.locator(".tlui-menu-zone");

// The toast drops in to the right of tldraw's top-left controls, centred on
// the menu button's row, and never moves them or covers them.
async function expectBesideMenu(page: Page): Promise<Box> {
  const button = await boxOf(page.getByTestId("main-menu.button"));
  const zone = await boxOf(menuZone(page));
  // Once its entrance is over.
  await expect
    .poll(async () => {
      const box = await boxOf(toast(page));
      return Math.round(box.y + box.height / 2 - (button.y + button.height / 2));
    })
    .toBe(0);
  const box = await boxOf(toast(page));
  expect(box.x).toBeGreaterThanOrEqual(zone.x + zone.width);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(overlap(box, zone)).toBe(false);
  return box;
}

test("the toast sits beside tldraw's menu on a phone, which stays put, on one line", async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await startBoard(page);
  const menu = page.getByTestId("main-menu.button");
  const pageMenu = page.getByTestId("page-menu.button");
  const atRest = [await boxOf(menu), await boxOf(pageMenu)];
  await roll(page, [20, 20, 20, 20, 6, 6, 6, 6, 8, 8, 8, 8, 10, 10, 12, 12, 4, 4, 100, 100]);
  await expect(toast(page)).toBeVisible();

  const box = await expectBesideMenu(page);
  expect(box.height).toBeLessThan(40);
  expect([await boxOf(menu), await boxOf(pageMenu)]).toEqual(atRest);
  const rows = await toast(page)
    .getByRole("img")
    .evaluateAll((dice) => new Set(dice.map((die) => die.getBoundingClientRect().top)).size);
  expect(rows).toBe(1);
  // The total stays in view at the end of a row of dice that scrolls.
  const sum = toast(page).getByText(/^\d+$/u).last();
  const end = await boxOf(sum);
  expect(end.x + end.width).toBeLessThanOrEqual(box.x + box.width);

  // The tray starts below the toast and the menus.
  const tray = await boxOf(page.locator("[data-dice-tier]"));
  expect(tray.y).toBeGreaterThanOrEqual(box.y + box.height);
  const zone = await boxOf(menuZone(page));
  expect(tray.y).toBeGreaterThanOrEqual(zone.y + zone.height);

  await toast(page).click();
  await expect(toast(page)).toHaveCount(0);
  expect([await boxOf(menu), await boxOf(pageMenu)]).toEqual(atRest);
});

test("a new roll takes the tray over from the one before", async ({ browser, page }) => {
  const boardUrl = await startBoard(page);
  const guest = await guestOn(browser, boardUrl);
  const ready = await fillPool(guest, [6]);

  await roll(page, [20, 20, 20]);
  await ready.getByRole("button", { name: /^Roll/u }).click();

  await expect(toast(page)).toContainText("Bea");
  await expect(diceCanvas(page)).toHaveCount(1);
  await expectNoCspViolations(page);
  await guest.context().close();
});

test("with reduced motion the toast shows at once and no 3D code is fetched", async ({
  browser,
  page,
}) => {
  const boardUrl = await startBoard(page);
  const guest = await guestOn(browser, boardUrl, { reducedMotion: "reduce" });
  const fetched: string[] = [];
  guest.on("request", (request) => fetched.push(request.url()));
  // Past the idle warm-up, which is when the 3D code would have been fetched.
  await guest.waitForTimeout(6000);

  await roll(page, [6, 6]);
  await expect(toast(guest)).toBeVisible();
  await expect(toast(guest)).toContainText("Ada");
  await expect(tray(guest)).toHaveCount(0);
  expect(fetched.filter((url) => url.includes("dice-scene"))).toEqual([]);
  await guest.context().close();
});

test("a lost connection is said below the top row, clear of the toast and the menus", async ({
  browser,
  page,
}) => {
  const boardUrl = await startBoard(page);
  const context = await browser.newContext({ ...PHONE, reducedMotion: "reduce" });
  let cut = false;
  const sockets: { close: () => Promise<void> }[] = [];
  await context.routeWebSocket(/\/connect/u, async (socket) => {
    if (cut) {
      await socket.close();
      return;
    }
    socket.connectToServer();
    sockets.push(socket);
  });
  const guest = await context.newPage();
  await collectCspViolations(guest);
  await guest.goto(boardUrl);
  await joinAs(guest, "Bea");
  await roll(page, [6]);
  await expect(toast(guest)).toBeVisible();

  cut = true;
  await Promise.all(sockets.map(async (socket) => socket.close()));
  const banner = guest.getByRole("status").filter({ hasText: "Connection lost" });
  await expect(banner).toBeVisible();
  const said = await boxOf(banner);
  for (const other of [toast(guest), menuZone(guest)]) {
    const box = await boxOf(other);
    expect(said.y).toBeGreaterThanOrEqual(box.y + box.height);
  }
  await expectNoCspViolations(guest);
  await context.close();
});

test("without WebGL2 the toast carries the result, and says so once", async ({ browser, page }) => {
  const boardUrl = await startBoard(page);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      return kind === "webgl2" ? null : Reflect.apply(original, this, [kind, ...rest]);
    } as typeof original;
  });
  const guest = await context.newPage();
  const errors: string[] = [];
  guest.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await guest.goto(boardUrl);
  await joinAs(guest, "Bea");

  await roll(page, [20]);
  await expect(toast(guest)).toContainText("Ada");
  await toast(guest).click();
  await roll(page, [8]);
  await expect(toast(guest)).toContainText("Ada");
  await expect(tray(guest)).toHaveCount(0);
  expect(errors.filter((text) => text.includes("3D dice unavailable"))).toHaveLength(1);
  await context.close();
});

test("the tray comes back after a lost context and follows a resize", async ({ page }) => {
  await startBoard(page);
  await roll(page, [6, 20]);
  await expect(toast(page)).toBeVisible();
  const settled = await shoot(tray(page));

  await diceCanvas(page).evaluate(async (canvas: HTMLCanvasElement) => {
    const lose = canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    const restored = new Promise((resolve) => {
      canvas.addEventListener("webglcontextrestored", resolve, { once: true });
    });
    lose.loseContext();
    await new Promise((resolve) => {
      canvas.addEventListener("webglcontextlost", resolve, { once: true });
    });
    // NOTE: the browser allows a restore only once the lost event has been
    // through every listener, so not from inside its dispatch.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    lose.restoreContext();
    await restored;
  });
  await expect
    .poll(async () => shows(tray(page), settled), { message: "the same dice are drawn again" })
    .toBe(true);

  await page.setViewportSize({ height: 600, width: 500 });
  await expect
    .poll(async () =>
      diceCanvas(page).evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.width === Math.round(canvas.clientWidth * devicePixelRatio) &&
          canvas.height === Math.round(canvas.clientHeight * devicePixelRatio) &&
          canvas.clientWidth === 500,
      ),
    )
    .toBe(true);
  expect(await shows(tray(page), settled)).toBe(false);
  await expectNoCspViolations(page);
});

const SHOTS = "/home/user/ludamus/screenshots/board";

// tldraw's page menu shares the top row with the main menu, and its name
// sets how wide that corner is; on a wide screen tldraw keeps its style
// panel at the top right. The toast fits between, and the menus stay put.
test("the toast fits between the page menu and the style panel, on phones and a desktop", async ({
  browser,
  page,
}) => {
  const boardUrl = await startBoard(page);
  mkdirSync(SHOTS, { recursive: true });
  const screens = [
    ["phone-360", { ...PHONE, viewport: { height: 740, width: 360 } }],
    ["phone-390", { ...PHONE, viewport: { height: 844, width: 390 } }],
    ["phone-430", { ...PHONE, viewport: { height: 932, width: 430 } }],
    ["desktop", devices["Desktop Chrome"]],
  ] as const;
  for (const [name, device] of screens) {
    // NOTE: reduced motion puts the toast up at once, so the shots are still.
    const screen = await guestOn(browser, boardUrl, {
      ...device,
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    const pageMenu = screen.getByTestId("page-menu.button");
    await expect(pageMenu).toBeVisible();
    const atRest = await boxOf(menuZone(screen));
    await roll(screen, [20, 6]);
    await expect(toast(screen)).toBeVisible();
    const box = await expectBesideMenu(screen);
    expect(await boxOf(menuZone(screen))).toEqual(atRest);
    for (const control of await screen.locator(".tlui-layout__top__right > *").all()) {
      expect(overlap(box, await boxOf(control))).toBe(false);
    }
    await screen.screenshot({ path: `${SHOTS}/toast-pages-${name}.png` });
    await pageMenu.click();
    const list = screen.getByTestId("page-menu.list");
    await expect(list).toBeVisible();
    await screen.screenshot({ path: `${SHOTS}/toast-pages-${name}-menu.png` });
    await expectNoCspViolations(screen);
    await screen.context().close();
  }
});

// The dice and the total come before the roller's name: the name shows only
// when every die fits beside it, never squeezing the seventh die into the
// row's fade; with more dice than fit, the row scrolls and the total stays.
test("the toast gives its row to the dice before the roller's name", async ({ browser, page }) => {
  const boardUrl = await startBoard(page);
  mkdirSync(SHOTS, { recursive: true });
  const pools = {
    3: [20, 6, 8],
    7: [4, 6, 8, 10, 12, 20, 100],
    20: [20, 20, 20, 20, 6, 6, 6, 6, 8, 8, 8, 8, 10, 10, 12, 12, 4, 4, 100, 100],
  };
  for (const width of [360, 390, 430]) {
    const screen = await guestOn(browser, boardUrl, {
      ...PHONE,
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      viewport: { height: 844, width },
    });
    for (const [count, pool] of Object.entries(pools)) {
      const dice = await openSheet(screen, "Dice");
      const clear = dice.getByRole("button", { name: "Clear" });
      if (await clear.isVisible()) await clear.click();
      await closeSheet(screen, "Dice");
      await roll(screen, pool);
      await expect(toast(screen).getByRole("img")).toHaveCount(pool.length);
      const box = await expectBesideMenu(screen);
      const dies = await toast(screen)
        .getByRole("img")
        .evaluateAll((all) =>
          all.map((die) => {
            const { left, right, top } = die.getBoundingClientRect();
            return { left, right, top };
          }),
        );
      expect(new Set(dies.map((die) => die.top)).size, "one row").toBe(1);
      const sum = await boxOf(toast(screen).getByText(/^\d+$/u).last());
      expect(sum.x + sum.width).toBeLessThanOrEqual(box.x + box.width);
      const row = await boxOf(toast(screen).getByRole("img").first().locator(".."));
      const allFit = dies.every(
        (die) => die.left >= row.x - 0.5 && die.right <= row.x + row.width + 0.5,
      );
      const named = (await toast(screen).textContent())!.includes("Bea");
      if (named) expect(allFit, `${count} dice at ${width} px fit beside the name`).toBe(true);
      if (count === "3") expect(named, `the name beside 3 dice at ${width} px`).toBe(true);
      if (count === "20") expect(named, `no name beside 20 dice at ${width} px`).toBe(false);
      await screen.screenshot({ path: `${SHOTS}/toast2-${width}-${count}.png` });
      await toast(screen).click();
      await expect(toast(screen)).toHaveCount(0);
    }
    await screen.context().close();
  }
});
