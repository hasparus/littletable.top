import { expect, test } from "@playwright/test";

import { STANDALONE } from "../ports";
import { collectCspViolations, expectNoCspViolations, PHONE, reviewShot } from "./helpers";

test("a guest submits feedback from the phone board menu and can retry a failed send", async ({
  browser,
}) => {
  const context = await browser.newContext({ ...PHONE, reducedMotion: "reduce" });
  const page = await context.newPage();
  const submissions: object[] = [];
  await collectCspViolations(page);
  await page.route("**/api/feedback", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 204 });
      return;
    }
    submissions.push(route.request().postDataJSON() as object);
    await route.fulfill({ status: submissions.length === 1 ? 502 : 204 });
  });
  await page.goto(`${STANDALONE}/?lang=en`);
  const menu = page.getByTestId("main-menu.button");
  await menu.click();
  const item = page.getByRole("menuitem", { name: "Send feedback" });
  await expect(item).toBeVisible();
  await reviewShot(page, "feedback-phone-menu");
  await item.click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const send = dialog.getByRole("button", { exact: true, name: "Send" });
  const description = dialog.getByLabel("Description");
  await expect(send).toBeDisabled();
  await description.fill("The dice roll is hard to read on a small screen.");
  await reviewShot(page, "feedback-phone-dialog");
  await send.click();
  await expect(dialog.getByRole("alert")).toContainText("Please try again");
  await expect(description).toHaveValue("The dice roll is hard to read on a small screen.");
  await send.click();
  await expect(dialog.getByRole("status")).toHaveText("Thanks for the feedback!");
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(submissions[0]).toMatchObject({ category: "bug", role: "guest", screen: "board" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
  await expectNoCspViolations(page);
  await context.close();
});

test("the desktop boards page offers the same form for improvements", async ({ page }) => {
  await page.route("**/api/feedback", (route) => route.fulfill({ status: 204 }));
  await page.goto(`${STANDALONE}/boards?lang=en`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("radio", { name: "Suggest an improvement" }).check();
  await dialog.getByLabel("Description").fill("Let me pin the board we play on every week.");
  await reviewShot(page, "feedback-desktop-dialog");
  const sent = page.waitForRequest(
    (request) => request.url().endsWith("/api/feedback") && request.method() === "POST",
  );
  await dialog.getByRole("button", { exact: true, name: "Send" }).click();
  const request = await sent;
  expect(request.postDataJSON()).toMatchObject({
    category: "improvement",
    role: "member",
    screen: "boards",
  });
  await expect(dialog.getByRole("status")).toHaveText("Thanks for the feedback!");
});
