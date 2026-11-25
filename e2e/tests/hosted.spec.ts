import { expect, test } from "@playwright/test";

import { boardAt, HOST, HOSTED, socketOf } from "../ports";
import {
  collectCspViolations,
  expectNoCspViolations,
  expectOwnPolicy,
  joinAs,
  onBoard,
  phone,
  putNote,
  rollTwoD6,
} from "./helpers";

const ON_TABLETOP = boardAt(HOSTED);

test("the board uses one synchronized spinner during bootstrap and connection", async ({
  page,
}) => {
  const bootstrap = Promise.withResolvers<null>();
  const connection = Promise.withResolvers<null>();
  await page.route("**/b/*/bootstrap/", async (route) => {
    await bootstrap.promise;
    await route.continue();
  });
  await page.routeWebSocket(/\/connect/u, (socket) => {
    const server = socket.connectToServer();
    server.onMessage(async (message) => {
      await connection.promise;
      socket.send(message);
    });
  });

  try {
    await page.goto(`${HOST}/sign-in?name=Spinner`);
    await page.getByRole("button", { name: "New board" }).click();
    await expect(page).toHaveURL(ON_TABLETOP);

    const loading = page.getByRole("status").filter({ hasText: "Opening the board…" });
    const spinner = page.locator(".tl-spinner:visible");
    await expect(loading).toHaveCount(1);
    await expect(loading.getByText("Opening the board…")).toHaveCSS("clip-path", "inset(50%)");
    await expect(spinner).toHaveCount(1);
    const box = await spinner.boundingBox();
    const rotationStart = () => spinner.evaluate((node) => node.getAnimations()[0]?.startTime);
    expect(await rotationStart()).toBe(0);

    bootstrap.resolve(null);
    await expect(page.locator("[data-board-editor]").locator(spinner)).toBeVisible();
    await expect(spinner).toHaveCount(1);
    expect(await rotationStart()).toBe(0);
    const syncedBox = await spinner.boundingBox();
    expect(syncedBox!.x + syncedBox!.width / 2).toBeCloseTo(box!.x + box!.width / 2);
    expect(syncedBox!.y + syncedBox!.height / 2).toBeCloseTo(box!.y + box!.height / 2);

    connection.resolve(null);
    await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
    await expect(loading).toHaveCount(0);
  } finally {
    bootstrap.resolve(null);
    connection.resolve(null);
  }
});

test("a member and a guest share a board the host signed them onto", async ({ browser, page }) => {
  await collectCspViolations(page);

  await page.goto(`${HOST}/sign-in?name=Ada`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  const boardUrl = page.url();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expectOwnPolicy(page, `'self' ${socketOf(HOSTED)} ${HOST}`);
  await expect(page).toHaveTitle(/^Board \d+$/u);
  const title = await page.title();

  const guest = await phone(browser, boardUrl);
  await joinAs(guest, "Bea");

  await putNote(page, { at: { x: 200, y: 300 }, text: "Hello table" });
  await expect(onBoard(guest, "Hello table")).toBeVisible();
  await rollTwoD6(guest, page, "Bea");

  const host = await page.context().newPage();
  await host.goto(`${HOST}/boards/`);
  await host.getByRole("button", { exact: true, name: `Reset link of ${title}` }).click();
  await expect(
    guest.getByText("The board's link was reset. Ask its creator for the new one."),
  ).toBeVisible({ timeout: 1000 });
  await expect(guest.getByRole("link", { name: "Back to Fake host" })).toBeVisible();

  await page.goto(
    await host.getByRole("link", { exact: true, name: title }).getAttribute("href").then(String),
  );
  await expect(page).not.toHaveURL(boardUrl);
  await expect(onBoard(page, "Hello table")).toBeVisible();

  await host.getByRole("button", { exact: true, name: `Delete ${title}` }).click();
  await expect(page.getByText("This board no longer exists.")).toBeVisible();

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
});
