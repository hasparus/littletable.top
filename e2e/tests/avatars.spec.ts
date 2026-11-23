import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { boardAt, HOST, HOSTED, STANDALONE, WORKOS } from "../ports";
import { collectCspViolations, expectNoCspViolations, joinAs, openSheet, PHONE } from "./helpers";

// People's pictures, in both modes: a member's shows in someone else's
// people list, loaded from the tabletop's own origin and never from the
// host or the sign-in provider; a guest shows an initial. The artifacts
// are the assertions and the screenshots.

const SHOTS = "/home/user/ludamus/screenshots/board";

// The picture inside a person's avatar, once it has really loaded, as the
// address it came from; null while there is only an initial.
async function pictureOf(avatar: Locator): Promise<string | null> {
  const picture = avatar.locator("img");
  if ((await picture.count()) === 0) return null;
  return picture.evaluate((image: HTMLImageElement) =>
    image.complete && image.naturalWidth > 0 ? image.src : null,
  );
}

// Every address the page asks for from now on.
function requestsOf(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => asked.push(request.url()));
  return asked;
}

async function guestPhone(browser: Browser, url: string, name: string): Promise<Page> {
  const context = await browser.newContext({ ...PHONE, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await collectCspViolations(page);
  await page.goto(url);
  await joinAs(page, name);
  return page;
}

test("hosted: a member's picture reaches a guest's people list from the tabletop itself", async ({
  browser,
  page,
}) => {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Ada`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(HOSTED));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const bea = await browser.newContext({ ...PHONE, deviceScaleFactor: 2 });
  const guest = await bea.newPage();
  await collectCspViolations(guest);
  const asked = requestsOf(guest);
  await guest.goto(page.url());
  await joinAs(guest, "Bea");

  const people = await openSheet(guest, "People");
  const ada = people.getByRole("img", { name: "Ada" });
  await expect
    .poll(async () => pictureOf(ada))
    .toMatch(new RegExp(String.raw`^${HOSTED}/rooms/[\w-]+/files/avatars/[0-9a-f]{64}$`, "u"));
  const own = people.getByRole("img", { name: "Bea" });
  await expect(own).toHaveText("B");
  expect(await pictureOf(own)).toBeNull();
  // The guest's browser asked the host for its pass and nothing else.
  expect(asked.filter((url) => url.startsWith(HOST) && !url.includes("/bootstrap/"))).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await guest.screenshot({ path: `${SHOTS}/avatars-people-phone.png` });

  // Ada sees her own picture, and Bea's initial.
  const hers = await openSheet(page, "People");
  await expect.poll(async () => pictureOf(hers.getByRole("img", { name: "Ada" }))).not.toBeNull();
  await expect(hers.getByRole("img", { name: "Bea" })).toHaveText("B");
  await page.screenshot({ path: `${SHOTS}/avatars-people-desktop.png` });

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await bea.close();
});

test("standalone: the account's picture is on the front page and on its boards", async ({
  browser,
}) => {
  const desk = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await desk.newPage();
  await collectCspViolations(page);
  const asked = requestsOf(page);
  await page.goto(`${STANDALONE}/`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Katherine Johnson");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Signed in as Katherine Johnson")).toBeVisible();

  const mine = page.getByRole("img", { name: "Katherine Johnson" });
  await expect
    .poll(async () => pictureOf(mine))
    .toMatch(new RegExp(String.raw`^${STANDALONE}/api/avatars/[0-9a-f]{64}$`, "u"));
  // The browser went to the provider to sign in, never for a picture.
  expect(asked.filter((url) => url.startsWith(`${WORKOS}/avatars/`))).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/avatars-front.png` });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({ path: `${SHOTS}/avatars-front-phone.png` });
  await page.setViewportSize({ height: 720, width: 1280 });

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const guest = await guestPhone(browser, page.url(), "Noor");
  const fromGuest = requestsOf(guest);
  const people = await openSheet(guest, "People");
  await expect
    .poll(async () => pictureOf(people.getByRole("img", { name: "Katherine Johnson" })))
    .toMatch(new RegExp(String.raw`^${STANDALONE}/rooms/[\w-]+/files/avatars/[0-9a-f]{64}$`, "u"));
  await expect(people.getByRole("img", { name: "Noor" })).toHaveText("N");
  expect(fromGuest.filter((url) => url.startsWith("http") && !url.startsWith(STANDALONE))).toEqual(
    [],
  );
  await guest.screenshot({ path: `${SHOTS}/avatars-people-phone-standalone.png` });

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
  await desk.close();
});
