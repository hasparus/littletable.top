import { expect, test } from "@playwright/test";

import {
  closeSheet,
  collectCspViolations,
  expectNoCspViolations,
  expectOwnPolicy,
  joinAs,
  onBoard,
  openSheet,
  phone,
  putNote,
  rollTwoD6,
  sheet,
} from "./helpers";

// Standalone mode on :8790: the tabletop is its own host. The owner signs
// in through the fake WorkOS on :8001 (the hosted AuthKit page's stand-in),
// makes a board on the front page, and a guest joins by its link with only
// a name. Nothing leaves the machine.

const TABLETOP = "http://localhost:8790";
const ON_BOARD = /^http:\/\/localhost:8790\/b\/(\w+)$/u;

test("an owner signs in and makes a board; a guest joins by link and plays", async ({
  browser,
  page,
}) => {
  await collectCspViolations(page);

  await page.goto(`${TABLETOP}/`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Signed in as Ada Lovelace")).toBeVisible();
  await expect(page.getByText("No boards yet.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);
  const boardUrl = page.url();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expectOwnPolicy(page, "'self' ws://localhost:8790;");

  // The guest, on a phone, has no account and needs none.
  const guest = await phone(browser, boardUrl);
  await joinAs(guest, "Bea");

  await putNote(page, { at: { x: 200, y: 300 }, text: "Hello table" });
  await expect(onBoard(guest, "Hello table")).toBeVisible();
  await rollTwoD6(guest, page, "Bea");

  // The owner makes a place of a note off the guest's small screen; the
  // guest jumps to it.
  await putNote(page, { at: { x: 1100, y: 250 }, text: "The map" });
  const places = await openSheet(page, "Places");
  await places.getByRole("button", { name: "Add to places" }).click();
  await places.getByLabel("Place name").fill("The map");
  await places.getByRole("button", { name: "Save" }).click();
  await expect(places.getByRole("button", { exact: true, name: "The map" })).toBeVisible();
  await closeSheet(page, "Places");
  const farNote = onBoard(guest, "The map");
  await expect(farNote).not.toBeInViewport();
  const guestPlaces = await openSheet(guest, "Places");
  await guestPlaces.getByRole("button", { exact: true, name: "The map" }).click();
  await expect(sheet(guest, "Places")).toBeHidden();
  await expect(farNote).toBeInViewport();

  // From the front page the owner renames the board and resets its link;
  // the guest, who has only the old link, is put out.
  const front = await page.context().newPage();
  await collectCspViolations(front);
  await front.goto(`${TABLETOP}/`);
  const row = front.getByRole("listitem").filter({ hasText: "Board" });
  await row.getByRole("button", { name: "Rename" }).click();
  await row.getByLabel("Board name").fill("Mörk Borg night");
  await row.getByRole("button", { name: "Save" }).click();
  const renamed = front.getByRole("listitem").filter({ hasText: "Mörk Borg night" });
  await renamed.getByRole("button", { name: "Reset link" }).click();
  await renamed.getByRole("alertdialog").getByRole("button", { name: "Reset link" }).click();
  await expect(
    guest.getByText("The board's link was reset. Ask its creator for the new one."),
  ).toBeVisible();
  const newLink = await front.getByRole("link", { name: "Mörk Borg night" }).getAttribute("href");
  expect(newLink).not.toBe(new URL(boardUrl).pathname);

  await page.goto(`${TABLETOP}${newLink}`);
  await expect(onBoard(page, "Hello table")).toBeVisible();
  await expect(page).toHaveTitle("Mörk Borg night");

  await expectNoCspViolations(page);
  await expectNoCspViolations(front);
  await expectNoCspViolations(guest);
  await guest.context().close();
});
