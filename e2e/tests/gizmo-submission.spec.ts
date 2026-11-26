import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { openGallery } from "./helpers";

const sha = "0123456789abcdef0123456789abcdef01234567";
const folder = "https://github.com/table-wizard/scenery/tree/" + sha + "/storm";
const pinned = "https://github.com/table-wizard/scenery/blob/" + sha + "/storm/gizmo.json";

test("an owner can submit the same link for public review without installing it on the board", async ({
  page,
}) => {
  await page.goto(STANDALONE + "/boards");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Sol");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  const marketplace = await openGallery(page, "Gizmo marketplace");
  const destination = marketplace.getByRole("combobox", { name: "Send link to" });
  await expect(destination).toHaveValue("board");
  await marketplace.getByRole("textbox", { name: /GitHub/ }).fill(folder);
  await destination.selectOption("public");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
  });
  await marketplace.getByRole("button", { name: "Submit for review" }).click();
  const confirmation = marketplace.getByRole("link", { name: "Continue on GitHub" });
  await expect(confirmation).toBeVisible();
  const href = new URL((await confirmation.getAttribute("href"))!);
  expect(href.searchParams.get("body")).toBe(pinned);
  expect(writes).toContain("/api/gizmo-submissions");
  expect(writes.some((path) => /\/rooms\/[^/]+\/gizmos$/u.test(path))).toBe(false);
  await destination.selectOption("board");
  await expect(confirmation).toHaveCount(0);
  await expect(marketplace.getByRole("button", { name: "Install", exact: true })).toBeVisible();
});

test("the practice marketplace can prepare a public submission", async ({ page }) => {
  await page.goto(STANDALONE + "/dev/gizmos/?empty&lang=en");
  const market = page.getByRole("dialog", { name: "Gizmo marketplace" });
  await market.getByRole("textbox", { name: /GitHub/ }).fill(folder);
  await market.getByRole("button", { name: "Submit for review" }).click();
  await expect(market.getByRole("link", { name: "Continue on GitHub" })).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/hasparus\/littletable.top\/issues\/new\?/u,
  );
  await expect(page.getByRole("dialog", { name: "Gizmo gallery" })).toHaveCount(0);
});
