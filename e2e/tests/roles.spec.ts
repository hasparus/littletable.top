import { type Browser, expect, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { boardAt, STANDALONE } from "../ports";
import { SCREENSHOT_DIR } from "../screenshots";
import { PHONE } from "./helpers";

// Standalone mode: a board's owner opens its people on the front page and
// makes one of them a shaman. On a phone, since that is where boards are
// run from. The artifacts are the screenshots in SCREENSHOTS.

const SCREENSHOTS = process.env.ROLES_SCREENSHOTS ?? SCREENSHOT_DIR;
const ON_BOARD = boardAt(STANDALONE);

async function signedIn(browser: Browser, name: string, locale = "en-GB"): Promise<Page> {
  const context = await browser.newContext({ ...PHONE, locale });
  const page = await context.newPage();
  await page.goto(`${STANDALONE}/`);
  await page.getByRole("link").first().click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  return page;
}

// The role the Worker put in the pass request's answer.
async function roleIn(answer: Promise<import("@playwright/test").Response>): Promise<string> {
  const response = await answer;
  const { person } = (await response.json()) as { person: { role: string } };
  return person.role;
}

test("an owner makes someone who joined a shaman, and takes it back", async ({ browser }) => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const owner = await signedIn(browser, "Ola Nowak");
  await expect(owner.getByText("Signed in as Ola Nowak")).toBeVisible();
  await owner.getByRole("button", { name: "New board" }).click();
  await expect(owner).toHaveURL(ON_BOARD);
  const boardUrl = owner.url();

  // Nobody has joined with an account yet.
  await owner.goto(`${STANDALONE}/`);
  const row = owner.getByRole("listitem").filter({ hasText: "Board" });
  await row.getByRole("button", { name: "People" }).click();
  const people = owner.getByRole("region", { name: "People" });
  await expect(
    people.getByText("Nobody has joined this board with an account yet.", { exact: false }),
  ).toBeVisible();
  await owner.screenshot({ path: `${SCREENSHOTS}/roles-empty.png` });
  await people.getByRole("button", { name: "Done" }).click();

  // Bea signs in and opens the board's link: now she is one of its people.
  const bea = await signedIn(browser, "Bea Kowalska");
  await expect(bea.getByText("Signed in as Bea Kowalska")).toBeVisible();
  const first = bea.waitForResponse((response) => response.url().endsWith("/bootstrap"));
  await bea.goto(boardUrl);
  expect(await roleIn(first)).toBe("write");

  await row.getByRole("button", { name: "People" }).click();
  const shaman = people.getByRole("checkbox", { name: "Shaman" });
  await expect(people.getByText("Bea Kowalska")).toBeVisible();
  await expect(shaman).not.toBeChecked();
  await shaman.check();
  await expect(shaman).toBeChecked();
  await owner.screenshot({ path: `${SCREENSHOTS}/roles-shaman.png` });

  // Her next pass says so.
  const second = bea.waitForResponse((response) => response.url().endsWith("/bootstrap"));
  await bea.reload();
  expect(await roleIn(second)).toBe("shaman");

  // It holds across a reload of the owner's page, and can be taken back.
  await owner.reload();
  await row.getByRole("button", { name: "People" }).click();
  await expect(shaman).toBeChecked();
  await shaman.uncheck();
  await expect(shaman).not.toBeChecked();
  const third = bea.waitForResponse((response) => response.url().endsWith("/bootstrap"));
  await bea.reload();
  expect(await roleIn(third)).toBe("write");

  // The same page in Polish.
  const ola = await signedIn(browser, "Ola Nowak", "pl-PL");
  await expect(ola.getByText("Zalogowano jako Ola Nowak")).toBeVisible();
  await ola
    .getByRole("listitem")
    .filter({ hasText: "Board" })
    .getByRole("button", { name: "Osoby" })
    .click();
  await expect(ola.getByRole("checkbox", { name: "Szaman" })).toBeVisible();
  await ola.screenshot({ path: `${SCREENSHOTS}/roles-pl.png` });
});
