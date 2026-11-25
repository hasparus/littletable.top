import type { Editor, TLPageId } from "tldraw";

import { expect, type Page, test } from "@playwright/test";

import { boardAt, STANDALONE } from "../ports";
import {
  collectCspViolations,
  expectNoCspViolations,
  joinAs,
  PHONE,
  putNote,
  reachEditor,
  reviewShot,
} from "./helpers";

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

function thumbnailPixels(page: Page, url: string | null) {
  return page.evaluate(async (source) => {
    const { __thumbnail } = globalThis as unknown as { __thumbnail: Blob };
    const blob = source === null ? __thumbnail : await fetch(source).then((res) => res.blob());
    const image = await createImageBitmap(blob);
    const { height, width } = image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    image.close();
    return {
      hasDrawing: data.some((value, index) => (index & 3) === 3 && value > 0),
      hasTransparency: data.some((value, index) => (index & 3) === 3 && value === 0),
      height,
      type: blob.type,
      width,
    };
  }, url);
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
  expect(await thumbnailPixels(page, captured.url())).toMatchObject({
    hasDrawing: true,
    hasTransparency: true,
    type: "image/webp",
  });
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

    await expect(visitor.getByText("Boards created", { exact: true })).toBeVisible();
    await expect(visitor.getByText("Boards joined", { exact: true })).toBeVisible();
    await expectThumbnail(visitor);
    await reviewShot(visitor, "board-thumbnail-mobile");
    await expectNoCspViolations(visitor);
  } finally {
    await phone.close();
  }
});

test("a thumbnail shows a remote drawing on another page and clears when it is erased", async ({
  browser,
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const { toBlob } = HTMLCanvasElement.prototype;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      toBlob.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
    };
    const send = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (typeof url === "string" && url.endsWith("/thumbnail") && init?.body instanceof Blob) {
        Reflect.set(globalThis, "__thumbnail", init.body);
      }
      return send(url, init);
    };
  });
  // WARNING: WebKit drops Secure sign-in cookies on the HTTP test server. Use the API fixture session for owner requests.
  const start = await request.get(`${STANDALONE}/auth/sign-in?return=/boards`, { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const authorize = new URL(start.headers().location!);
  authorize.searchParams.set("fake_user", "Page Thumbnail Tester");
  const signedIn = await request.get(authorize.toString());
  expect(signedIn.url()).toBe(`${STANDALONE}/boards`);
  await page.route(`${STANDALONE}/api/**`, async (route) => {
    const outgoing = route.request();
    // WARNING: WebKit does not expose the intercepted Blob body. Forward the encoded bytes passed to fetch.
    const data =
      outgoing.method() === "PUT" && outgoing.url().endsWith("/thumbnail")
        ? Buffer.from(
            await page.evaluate(async () => {
              const { __thumbnail } = globalThis as unknown as { __thumbnail: Blob };
              return [...new Uint8Array(await __thumbnail.arrayBuffer())];
            }),
          )
        : undefined;
    const response = await request.fetch(outgoing, { data });
    await route.fulfill({ response });
  });
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  const dice = page.getByRole("button", { exact: true, name: "Dice" });
  await expect(dice).toBeVisible();
  await reachEditor(page);
  await page.evaluate(() => {
    const editor = (globalThis as unknown as { __editor: Editor }).__editor;
    const id = "page:notes" as TLPageId;
    editor.createPage({ id, name: "Notes" });
    editor.setCurrentPage(id);
  });
  await expect(page.getByTestId("page-menu.button")).toHaveText("Notes");

  const guest = await browser.newContext();
  try {
    const painter = await guest.newPage();
    await painter.goto(page.url());
    await joinAs(painter, "Thumbnail Painter");
    await expect(painter.getByTestId("page-menu.button")).toHaveText("Page 1");
    const saved = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url().endsWith("/thumbnail"),
    );
    await putNote(painter, { at: { x: 230, y: 220 }, text: "A drawn map" });
    const populated = await saved;
    expect(populated.status()).toBe(204);
    expect(await thumbnailPixels(page, populated.url())).toMatchObject({
      hasDrawing: true,
      hasTransparency: true,
      type: "image/png",
    });
    await expect(page.getByTestId("page-menu.button")).toHaveText("Notes");

    await page.reload();
    await expect(dice).toBeVisible();
    await page.route("**/api/boards/*/thumbnail", (route) => route.fulfill({ status: 204 }));
    const cleared = page.waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/thumbnail"),
    );
    await reachEditor(painter);
    await painter.evaluate(() => {
      const editor = (globalThis as unknown as { __editor: Editor }).__editor;
      editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
    });
    await cleared;
    expect(await thumbnailPixels(page, null)).toEqual({
      hasDrawing: false,
      hasTransparency: true,
      height: 180,
      type: "image/png",
      width: 320,
    });
  } finally {
    await guest.close();
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
