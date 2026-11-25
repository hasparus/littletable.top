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

test("a member and a guest share a board the host signed them onto", async ({ browser, page }) => {
  await collectCspViolations(page);

  await page.goto(`${HOST}/sign-in?name=Ada`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  const boardUrl = page.url();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expectOwnPolicy(page, `'self' ${socketOf(HOSTED)} ${HOST}`);
  // The fake host assigns ids across the entire run.
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
