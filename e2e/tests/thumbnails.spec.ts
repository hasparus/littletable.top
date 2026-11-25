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

test("a pending thumbnail refresh survives a layer switch and retries a failed upload", async ({
  page,
}) => {
  await signIn(page, "Retry Thumbnail Tester");
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const initial = page.waitForResponse(
    (response) => response.request().method() === "PUT" && response.url().endsWith("/thumbnail"),
  );
  await putNote(page, { at: { x: 230, y: 220 }, text: "Initial preview" });
  const saved = await initial;
  expect(saved.status()).toBe(204);

  // Start with an existing thumbnail and a new capture controller. Stub
  // subsequent PUTs so this test does not need to wait out the server's
  // five-minute write interval.
  const bootstrap = page.waitForResponse((response) => response.url().endsWith("/bootstrap"));
  await page.reload();
  const admission = await bootstrap;
  expect(await admission.json()).toMatchObject({ thumbnail: { needed: false } });
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const attempts: number[] = [];
  await page.route("**/api/boards/*/thumbnail", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const status = attempts.length === 0 ? 503 : 204;
    await route.fulfill({ status });
    attempts.push(status);
  });

  await putNote(page, { at: { x: 510, y: 220 }, text: "Uncaptured edit" });
  const toggle = page.getByRole("button", { name: "Secret layer" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // Stay in the secret layer past the normal settle delay. No thumbnail
  // request should be sent while the shared layer is hidden.
  const inactiveUpload = await page
    .waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/thumbnail"),
      { timeout: 3500 },
    )
    .catch(() => null);
  expect(inactiveUpload).toBeNull();
  expect(attempts).toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => attempts, { timeout: 15_000 }).toEqual([503, 204]);
});
