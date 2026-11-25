import { expect, type Page, test } from "@playwright/test";

import { boardAt, STANDALONE } from "../ports";
import { collectCspViolations, expectNoCspViolations, PHONE, putNote, reviewShot } from "./helpers";

async function signIn(page: Page, name: string) {
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
}

function thumbnail(page: Page) {
  return page.locator('img[src$="/thumbnail"]');
}

async function expectThumbnail(page: Page) {
  const image = thumbnail(page);
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(({ naturalHeight, naturalWidth }: HTMLImageElement) => [
        naturalWidth,
        naturalHeight,
      ]),
    )
    .toEqual([320, 180]);
}

test("a drawing becomes a thumbnail in the created and joined board collections", async ({
  browser,
  page,
}) => {
  await collectCspViolations(page);
  await signIn(page, "Thumbnail Tester");
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const boardUrl = page.url();

  const stored = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/thumbnail"),
  );
  await putNote(page, { at: { x: 230, y: 220 }, text: "A torch-lit map" });
  const captured = await stored;
  expect(captured.status()).toBe(204);
  await page.goto(`${STANDALONE}/boards`);
  await expectThumbnail(page);
  await expectNoCspViolations(page);

  const phone = await browser.newContext(PHONE);
  try {
    const visitor = await phone.newPage();
    await collectCspViolations(visitor);
    await signIn(visitor, "Mobile Thumbnail Tester");
    await visitor.getByRole("button", { name: "New board" }).click();
    await expect(visitor).toHaveURL(boardAt(STANDALONE));
    await visitor.goto(boardUrl);
    await expect(visitor.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
    await visitor.goto(`${STANDALONE}/boards`);

    const summaries = visitor
      .locator("main details > summary")
      .filter({ hasText: /^Boards (?:created|joined)$/u });
    await expect(summaries).toHaveText(["Boards created", "Boards joined"]);
    await expectThumbnail(visitor);
    const joined = summaries.filter({ hasText: /^Boards joined$/u });
    await joined.click();
    await expect(thumbnail(visitor)).toBeHidden();
    await joined.click();
    await expectThumbnail(visitor);
    await reviewShot(visitor, "board-thumbnail-mobile");
    await expectNoCspViolations(visitor);
  } finally {
    await phone.close();
  }
});
