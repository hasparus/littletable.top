import {
  type Browser,
  devices,
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test";

import { HOST } from "../ports";
import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  openRollLog,
  openSheet,
  PHONE,
  reviewShot,
} from "./helpers";

const tray = (page: Page): Locator => page.locator("[data-dice-tier]");
const diceCanvas = (page: Page): Locator => tray(page).locator("canvas");
const toast = (page: Page): Locator => page.getByRole("button", { exact: true, name: "Close" });
const dieLabels = (container: Locator) =>
  container
    .getByRole("img")
    .evaluateAll((dice) => dice.map((die) => die.getAttribute("aria-label")));
const isRollRequest = (request: Request) =>
  request.method() === "POST" && new URL(request.url()).pathname.endsWith("/roll");

// WARNING: Disable animations in tray screenshots so a fading control cannot break the pixel comparison.
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
  await dice.getByRole("button", { name: /^Roll/u }).click();
  await expect(dice).toBeHidden();
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
    // WARNING: Hide the board during pixel comparisons so the other browser’s cursor cannot affect them.
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

  const reachesBoard = await tray(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [0.25, 0.5, 0.75].some((x) =>
      [0.25, 0.5, 0.75].some((y) => {
        const hit = document.elementFromPoint(box.x + box.width * x, box.y + box.height * y);
        return hit !== null && !element.contains(hit) && hit.closest(".tl-container") !== null;
      }),
    );
  });
  expect(reachesBoard).toBe(true);

  await toast(page).click();
  await expect(tray(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const dice = await openSheet(page, "Dice");
  await expect(dice.locator("details")).not.toHaveAttribute("open", "");
  const log = await openRollLog(dice);
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await closeSheet(page, "Dice");
  await expect(tray(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
});

test("a settled die can be dragged and thrown with the pointer", async ({ page }) => {
  await startBoard(page);
  await roll(page, [6]);
  const die = tray(page).locator("[data-die-object]");
  await expect(die).toBeVisible();
  const before = (await die.boundingBox())!;
  const x = before.x + before.width / 2;
  const y = before.y + before.height / 2;
  const dx = x < page.viewportSize()!.width / 2 ? 56 : -56;
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (isRollRequest(request)) requests.push(request);
  });

  await page.mouse.click(x, y);
  await expect(die).toBeVisible();
  expect(requests).toHaveLength(0);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y - 24, { steps: 4 });
  await expect
    .poll(async () => Math.abs((await die.boundingBox())!.x - before.x))
    .toBeGreaterThan(4);

  const thrown = page.waitForRequest(isRollRequest);
  await page.mouse.up();
  const request = await thrown;
  expect(request.postDataJSON()).toMatchObject({
    dice: [6],
    launch: {
      vx: expect.any(Number),
      vz: expect.any(Number),
      x: expect.any(Number),
      z: expect.any(Number),
    },
  });
  const log = await openRollLog(await openSheet(page, "Dice"));
  await expect(log.getByRole("listitem")).toHaveCount(2);
  expect(requests).toEqual([request]);
});

test("two phones show the same kept dice, modifier and total in the tray, toast and log", async ({
  browser,
  page,
}, testInfo) => {
  const viewport = { height: 740, width: 360 };
  await page.setViewportSize(viewport);
  const boardUrl = await startBoard(page);
  const guest = await guestOn(browser, boardUrl, { viewport });
  const dice = await openSheet(page, "Dice");
  const notation = dice.getByRole("textbox", { name: "Dice notation" });
  await notation.fill("3d6kh4");
  await notation.press("Enter");
  await expect(dice.getByRole("status")).toHaveText(
    "Keep or drop at least one die and at most the number of dice in the group.",
  );
  const emptyLog = await openRollLog(dice);
  await expect(emptyLog.getByRole("listitem")).toHaveCount(0);

  await notation.fill("2d20kl1 − 2");
  await closeSheet(page, "Dice");
  await openSheet(page, "People");
  await closeSheet(page, "People");
  await openSheet(page, "Dice");
  await expect(notation).toHaveValue("2d20kl1 − 2");
  await expect(dice.getByRole("button", { name: "Roll 2d20kl1 − 2" })).toBeEnabled();
  await reviewShot(page, "dice-notation-keep-lowest-phone");
  await notation.fill("3d6kh2 + 3");
  await reviewShot(page, "dice-notation-keep-highest-phone");
  await notation.press("Enter");
  await expect(dice).toBeHidden();
  await openSheet(page, "Dice");
  await expect(dice.getByRole("button", { name: "Roll 3d6kh2 + 3 again" })).toBeVisible();
  await closeSheet(page, "Dice");

  const result = toast(page);
  await expect(result.getByRole("img", { name: /\(dropped\)$/u })).toHaveCount(1);
  const expected = await dieLabels(result);
  const values = expected.map((label) => Number(/^d6: (\d+)/u.exec(label ?? "")?.[1]));
  const dropped = expected.findIndex((label) => label?.endsWith("(dropped)"));
  const kept = values.filter((_, index) => index !== dropped);
  expect(values[dropped]).toBe(Math.min(...values));
  const total = kept[0]! + kept[1]! + 3;
  const shots: Buffer[] = [];
  for (const [name, screen] of [
    ["roller", page],
    ["watcher", guest],
  ] as const) {
    await expect(toast(screen).getByRole("img", { name: expected[dropped]! })).toBeVisible();
    expect(await dieLabels(toast(screen))).toEqual(expected);
    await expect(toast(screen)).toHaveText(new RegExp(`\\+ 3 =\\s*${total}$`, "u"));
    await expect(screen.getByText(`Kept ${kept.join(", ")}`, { exact: false })).toBeAttached();
    await expect(diceCanvas(screen)).toBeVisible();

    await setVisibility(screen.locator(".tl-container"), "hidden");
    const shot = await shoot(tray(screen));
    await testInfo.attach(`notation-tray-${name}.png`, { body: shot, contentType: "image/png" });
    shots.push(shot);
    await setVisibility(screen.locator(".tl-container"), "");

    const log = await openRollLog(await openSheet(screen, "Dice"));
    const entry = log.getByRole("listitem").first();
    await expect(entry.getByText("3d6kh2 + 3", { exact: true })).toBeVisible();
    await expect(entry.getByText(`Total: ${total}`, { exact: false })).toBeAttached();
    expect(await dieLabels(entry)).toEqual(expected);
    if (screen === page) await reviewShot(screen, "dice-notation-result-phone");
    await closeSheet(screen, "Dice");
  }
  expect(shots[0]!.equals(shots[1]!)).toBe(true);
  await guest.context().close();
});

type Box = { height: number; width: number; x: number; y: number };

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const boxOf = async (target: Locator): Promise<Box> => (await target.boundingBox())!;

const menuZone = (page: Page): Locator => page.locator(".tlui-menu-zone");

async function expectInMenuRow(page: Page): Promise<Box> {
  const button = await boxOf(page.getByTestId("main-menu.button"));
  const zone = await boxOf(menuZone(page));
  await expect
    .poll(async () => {
      const box = await boxOf(toast(page));
      return Math.round(box.y + box.height / 2 - (button.y + button.height / 2));
    })
    .toBe(0);
  const box = await boxOf(toast(page));
  expect(overlap(box, zone)).toBe(false);
  return box;
}

async function expectBesideMenu(page: Page): Promise<Box> {
  const box = await expectInMenuRow(page);
  const zone = await boxOf(menuZone(page));
  expect(box.x).toBeGreaterThanOrEqual(zone.x + zone.width);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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
  const sum = toast(page).getByText(/^\d+$/u).last();
  const end = await boxOf(sum);
  expect(end.x + end.width).toBeLessThanOrEqual(box.x + box.width);

  const tray = await boxOf(page.locator("[data-dice-tier]"));
  expect(tray.y).toBeGreaterThanOrEqual(box.y + box.height);
  const zone = await boxOf(menuZone(page));
  expect(tray.y).toBeGreaterThanOrEqual(zone.y + zone.height);

  await toast(page).click();
  await expect(toast(page)).toHaveCount(0);
  expect([await boxOf(menu), await boxOf(pageMenu)]).toEqual(atRest);
});

test("the hamburger menu paints above the visible dice tray", async ({ page }) => {
  await page.setViewportSize({ height: 740, width: 390 });
  await startBoard(page);
  await roll(page, [6, 20]);
  await expect(toast(page)).toBeVisible();
  const canvas = diceCanvas(page);
  await expect(canvas).toBeVisible();
  const dice = await shoot(tray(page));
  await setVisibility(canvas, "hidden");
  expect(await shows(tray(page), dice), "dice are painted over the board").toBe(false);
  await setVisibility(canvas, "");

  await page.getByTestId("main-menu.button").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await reviewShot(page, "dice-hamburger-menu");
  const menuBox = await boxOf(menu);
  const canvasBox = await boxOf(canvas);
  const top = Math.max(menuBox.y, canvasBox.y) + 10;
  const bottom = Math.min(menuBox.y + menuBox.height, canvasBox.y + canvasBox.height) - 10;
  expect(bottom).toBeGreaterThan(top);
  const pixels = () =>
    page.screenshot({
      animations: "disabled",
      clip: { height: bottom - top, width: menuBox.width - 20, x: menuBox.x + 10, y: top },
    });
  await canvas.evaluate((element) => {
    element.style.backgroundColor = "magenta";
  });
  const aboveDice = await pixels();
  await setVisibility(canvas, "hidden");
  const withoutDice = await pixels();
  expect(withoutDice.equals(aboveDice), "the overlapping canvas cannot cover the menu").toBe(true);
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
  // WARNING: Wait past the idle warm-up so an unintended dice download would be observed.
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
  const banner = guest.getByRole("status").filter({ hasText: "Reconnecting…" });
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
    // WARNING: WebGL permits restoring a context only after the loss event has reached every listener. Restore after dispatch returns.
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

test("the toast centres on desktop and fits beside the page menu on phones", async ({
  browser,
  page,
}) => {
  const boardUrl = await startBoard(page);
  const screens = [
    ["phone-360", { ...PHONE, viewport: { height: 740, width: 360 } }],
    ["phone-390", { ...PHONE, viewport: { height: 844, width: 390 } }],
    ["phone-430", { ...PHONE, viewport: { height: 932, width: 430 } }],
    ["desktop", devices["Desktop Chrome"]],
  ] as const;
  for (const [name, device] of screens) {
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
    const box = await (name === "desktop" ? expectInMenuRow(screen) : expectBesideMenu(screen));
    if (name === "desktop") {
      expect(box.x + box.width / 2).toBeCloseTo(screen.viewportSize()!.width / 2, 0);
    }
    expect(await boxOf(menuZone(screen))).toEqual(atRest);
    for (const control of await screen.locator(".tlui-layout__top__right > *").all()) {
      expect(overlap(box, await boxOf(control))).toBe(false);
    }
    await reviewShot(screen, `toast-pages-${name}`);
    await pageMenu.click();
    const list = screen.getByTestId("page-menu.list");
    await expect(list).toBeVisible();
    await reviewShot(screen, `toast-pages-${name}-menu`);
    await expectNoCspViolations(screen);
    await screen.context().close();
  }
});

test("the toast gives its row to the dice before the roller's name", async ({ browser, page }) => {
  const boardUrl = await startBoard(page);
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
      await reviewShot(screen, `toast2-${width}-${count}`);
      await toast(screen).click();
      await expect(toast(screen)).toHaveCount(0);
    }
    await screen.context().close();
  }
});
