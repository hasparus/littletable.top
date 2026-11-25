import { type Browser, expect, type Page, type Response, test } from "@playwright/test";

import { boardAt, STANDALONE } from "../ports";
import { PHONE, reviewShot } from "./helpers";

const ON_BOARD = boardAt(STANDALONE);

async function signedIn(browser: Browser, name: string, language = "en") {
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  await page.goto(`${STANDALONE}/boards?lang=${language}`);
  await page.getByRole("link", { name: language === "pl" ? "Zaloguj się" : "Sign in" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${STANDALONE}/boards`);
  return page;
}

async function roleIn(answer: Promise<Response>) {
  const response = await answer;
  const { person }: { person: { role: string } } = await response.json();
  return person.role;
}

const isBootstrap = (response: Response) => response.url().endsWith("/bootstrap");

async function openPeople(page: Page, menu: RegExp, label: string) {
  const row = page.getByRole("listitem").filter({ hasText: /^Board /u });
  await row.getByLabel(menu).click();
  await row.getByRole("button", { name: label }).click();
  return page.getByRole("region", { name: label });
}

test("an owner can grant and revoke a board manager role", async ({ browser }) => {
  const owner = await signedIn(browser, "Ola Nowak");
  await owner.getByRole("button", { name: "New board" }).click();
  await expect(owner).toHaveURL(ON_BOARD);
  const boardUrl = owner.url();

  await owner.goto(`${STANDALONE}/boards`);
  const people = await openPeople(owner, /^Manage /u, "People");
  await expect(people.getByText("Nobody has joined this board with an account yet.")).toBeVisible();
  await reviewShot(owner, "roles-empty");
  await people.getByRole("button", { name: "Done" }).click();

  const member = await signedIn(browser, "Bea Kowalska");
  const first = member.waitForResponse(isBootstrap);
  await member.goto(boardUrl);
  expect(await roleIn(first)).toBe("write");

  await openPeople(owner, /^Manage /u, "People");
  const manager = people.getByRole("checkbox", { name: "Manager" });
  await expect(people.getByText("Bea Kowalska")).toBeVisible();
  await expect(manager).not.toBeChecked();
  await manager.click();
  await expect(manager).toBeChecked();
  await reviewShot(owner, "roles-manager");

  const second = member.waitForResponse(isBootstrap);
  await member.reload();
  expect(await roleIn(second)).toBe("shaman");

  await owner.reload();
  await openPeople(owner, /^Manage /u, "People");
  await expect(manager).toBeChecked();
  await manager.click();
  await expect(manager).not.toBeChecked();

  const third = member.waitForResponse(isBootstrap);
  await member.reload();
  expect(await roleIn(third)).toBe("write");

  const polish = await signedIn(browser, "Ola Nowak", "pl");
  const polishPeople = await openPeople(polish, /^Zarządzaj tablicą /u, "Osoby");
  await expect(polishPeople.getByRole("checkbox", { name: "Opiekun tablicy" })).toBeVisible();
  await reviewShot(polish, "roles-pl");
});
