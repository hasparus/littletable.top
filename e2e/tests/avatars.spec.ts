import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";

import { boardAt, HOST, HOSTED, STANDALONE, WORKOS } from "../ports";
import {
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  openSheet,
  PHONE,
  reviewShot,
} from "./helpers";

// People's pictures, in both modes: a member's shows in someone else's
// people list, loaded from the tabletop's own origin and never from the
// host or the sign-in provider; a guest shows an initial. The artifacts
// are the assertions and the screenshots.

// A person's row in the people list. The avatar is decoration beside the
// name, so the row is found by the name it says.
const rowOf = (people: Locator, name: string): Locator =>
  people.getByRole("listitem").filter({ hasText: name });

// The picture in a person's avatar, once it has really loaded, as the
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
  await expect
    .poll(async () => pictureOf(rowOf(people, "Ada")))
    .toMatch(new RegExp(String.raw`^${HOSTED}/rooms/[\w-]+/files/avatars/[0-9a-f]{64}$`, "u"));
  // A screen reader hears each name once, not the avatar's too.
  await expect(people.getByRole("button", { exact: true, name: "Ada Follow" })).toBeVisible();
  const own = rowOf(people, "Bea");
  await expect(own.getByText("B", { exact: true })).toBeVisible();
  expect(await pictureOf(own)).toBeNull();
  // The guest's browser asked the host for its pass and nothing else.
  expect(asked.filter((url) => url.startsWith(HOST) && !url.includes("/bootstrap/"))).toEqual([]);
  await reviewShot(guest, "avatars-people-phone");

  // Ada sees her own picture, and Bea's initial.
  const hers = await openSheet(page, "People");
  await expect.poll(async () => pictureOf(rowOf(hers, "Ada"))).not.toBeNull();
  await expect(rowOf(hers, "Bea").getByText("B", { exact: true })).toBeVisible();
  await reviewShot(page, "avatars-people-desktop");

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

  const mine = page.getByRole("banner");
  await expect
    .poll(async () => pictureOf(mine))
    .toMatch(new RegExp(String.raw`^${STANDALONE}/api/avatars/[0-9a-f]{64}$`, "u"));
  // The browser went to the provider to sign in, never for a picture.
  expect(asked.filter((url) => url.startsWith(`${WORKOS}/avatars/`))).toEqual([]);
  await reviewShot(page, "avatars-front");
  await page.setViewportSize({ height: 844, width: 390 });
  await reviewShot(page, "avatars-front-phone");
  await page.setViewportSize({ height: 720, width: 1280 });

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  const guest = await guestPhone(browser, page.url(), "Noor");
  const fromGuest = requestsOf(guest);
  const people = await openSheet(guest, "People");
  await expect
    .poll(async () => pictureOf(rowOf(people, "Katherine Johnson")))
    .toMatch(new RegExp(String.raw`^${STANDALONE}/rooms/[\w-]+/files/avatars/[0-9a-f]{64}$`, "u"));
  await expect(rowOf(people, "Noor").getByText("N", { exact: true })).toBeVisible();
  expect(fromGuest.filter((url) => url.startsWith("http") && !url.startsWith(STANDALONE))).toEqual(
    [],
  );
  await reviewShot(guest, "avatars-people-phone-standalone");

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
  await desk.close();
});
