import { expect, test } from "@playwright/test";

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
  putNote,
  rollTwoD6,
  sheet,
} from "./helpers";

// Standalone mode: the tabletop is its own host. The owner signs
// in through e2e/fake-workos.ts (the hosted AuthKit page's stand-in),
// makes a board on the front page, and a guest joins by its link with only
// a name. Nothing leaves the machine.

const ON_BOARD = boardAt(STANDALONE);

test("the home page is one editable public board for anonymous visitors", async ({
  browser,
  page,
}) => {
  await page.goto(`${STANDALONE}/`);
  const guest = await phone(browser, `${STANDALONE}/`);

  const intro = guest.getByRole("region", { name: "Public whiteboard" });
  await expect(intro.getByRole("heading", { level: 1 })).toBeInViewport();
  await expect(intro.getByText("So I made Little Table.", { exact: false })).toBeInViewport();
  await expect(guest.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(guest.getByLabel("Your name")).toHaveCount(0);

  await putNote(page, { at: { x: 200, y: 648 }, text: "A note from the public board" });
  await expect(onBoard(guest, "A note from the public board")).toBeInViewport();
  await expectNoCspViolations(guest);
  await guest.context().close();
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
  await expect(page.getByText("Signed in as Ada Lovelace")).toBeVisible();
  await expect(page.getByText("No boards yet.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);
  const boardUrl = page.url();
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  await expectOwnPolicy(page, `'self' ${socketOf(STANDALONE)};`);

  // The guest, on a phone, has no account and needs none.
  const guest = await phone(browser, boardUrl);
  await joinAs(guest, "Bea");

  await putNote(page, { at: { x: 200, y: 300 }, text: "Hello table" });
  await expect(onBoard(guest, "Hello table")).toBeVisible();
  await rollTwoD6(guest, page, "Bea");

  // The owner makes a place of a note off the guest's small screen; the
  // guest jumps to it.
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

  // From the front page the owner renames the board and resets its link;
  // the guest, who has only the old link, is put out.
  const front = await page.context().newPage();
  await collectCspViolations(front);
  await front.goto(`${STANDALONE}/boards`);
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
  const link = front.getByRole("link", { name: "Mörk Borg night" });
  // NOTE: the list shows the new link once the reset's answer is in.
  await expect(link).not.toHaveAttribute("href", new URL(boardUrl).pathname);
  const newLink = await link.getAttribute("href");

  await page.goto(`${STANDALONE}${newLink}`);
  await expect(onBoard(page, "Hello table")).toBeVisible();
  await expect(page).toHaveTitle("Mörk Borg night");

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
