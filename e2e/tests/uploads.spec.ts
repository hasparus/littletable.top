import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

import { png } from "../fixtures/png";
import { boardAt, HOST, HOSTED, STANDALONE } from "../ports";
import { collectCspViolations, expectNoCspViolations, joinAs, phone, reviewShot } from "./helpers";
import {
  documentOf,
  documentOfFile,
  downloadTldr,
  dropFile,
  expectWhole,
  fixture,
  loadedImages,
  openTldr,
  sha256,
  toast,
  uploadImage,
  zoomToFit,
} from "./tldr";

// Images and .tldr files, end to end: what one browser brings onto a board,
// another sees, from the Worker's R2 bucket. The artifacts are the .tldr
// files the browsers download, written to test-results/, which the
// assertions compare with the fixtures.

const ON_TABLETOP = boardAt(HOSTED);
const ON_BOARD = boardAt(STANDALONE);

const MAP = readFileSync(fixture("map.png"));
const PORTRAIT = readFileSync(fixture("portrait.png"));
// Where the Worker keeps an image: under the board's id and its SHA-256.
const imageAt = (bytes: Buffer) =>
  new RegExp(String.raw`^/rooms/[\w-]+/files/${sha256(bytes)}$`, "u");
const stored = imageAt(MAP);

test("an image one person uploads loads for a guest, and again after a reload", async ({
  browser,
  page,
}) => {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Iris`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  const guest = await phone(browser, page.url());
  await joinAs(guest, "Noor");

  await uploadImage(page, "map.png");

  await expect.poll(() => loadedImages(page)).toEqual([expect.stringMatching(stored)]);
  // The image lands where the uploader looks; the guest's small screen
  // zooms to everything on the board.
  // NOTE: again on each look: a zoom that comes before the image's shape
  // has synced fits an empty board and leaves the image off screen.
  const seenByGuest = async () => {
    await zoomToFit(guest);
    return loadedImages(guest);
  };
  await expect.poll(seenByGuest).toEqual([expect.stringMatching(stored)]);
  await guest.reload();
  await expect.poll(seenByGuest).toEqual([expect.stringMatching(stored)]);

  // The address opens nothing without the board's pass.
  const [address] = await loadedImages(guest);
  const stranger = await browser.newContext();
  const refused = await stranger.request.get(`${HOSTED}${address}`);
  expect(refused.status()).toBe(403);
  await stranger.close();

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
});

test("a photo larger than the pixel budget arrives redrawn to it", async ({ page }) => {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Lin`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  const photo = png(6000, 4000, [90, 60, 20]);

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("main-menu.button").click();
  await page.getByRole("menuitem", { name: "Upload media…" }).click();
  const picker = await chooser;
  await picker.setFiles({ buffer: photo, mimeType: "image/png", name: "photo.png" });

  const canvas = page.getByTestId("canvas");
  await expect
    .poll(() =>
      canvas
        .locator("img.tl-image")
        .evaluateAll((images) =>
          (images as HTMLImageElement[])
            .filter((image) => image.complete && new URL(image.src).pathname.startsWith("/rooms/"))
            .map((image) => [image.naturalWidth, image.naturalHeight]),
        ),
    )
    .toEqual([[4096, 2731]]);
  const [address = ""] = await loadedImages(page);
  expect(address).not.toMatch(imageAt(photo));
  await expectNoCspViolations(page);
});

test("a .tldr file opened on one screen reaches the other whole, and comes back out the same", async ({
  browser,
  page,
}, testInfo) => {
  await collectCspViolations(page);
  await page.goto(`${STANDALONE}/`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Grace Hopper");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);
  const guest = await phone(browser, page.url());
  await joinAs(guest, "Noor");

  await openTldr(page, "table.tldr");
  await expect(toast(page, "The file's pages were added to the board.")).toBeVisible();

  // The guest lands on the file's first page and sees its map, from R2.
  await expect.poll(() => loadedImages(guest)).toEqual([expect.stringMatching(stored)]);
  const seen = await downloadTldr(guest);
  writeFileSync(testInfo.outputPath("seen-by-the-guest.tldr"), seen);
  const original = documentOfFile("table.tldr");
  expect(documentOf(seen)).toEqual(original);
  const assets = documentOf(seen).assets.map((asset) => asset.props!.src);
  expect(assets).toEqual([`sha256:${sha256(MAP)}`, `sha256:${sha256(PORTRAIT)}`]);

  // What came out opens on a fresh board as the same document again.
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_BOARD);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("main-menu.button").click();
  await page.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
  const picker = await chooser;
  await picker.setFiles({ buffer: Buffer.from(seen), mimeType: "", name: "seen.tldr" });
  await expect(toast(page, "The file's pages were added to the board.")).toBeVisible();
  const again = await downloadTldr(page);
  writeFileSync(testInfo.outputPath("round-trip.tldr"), again);
  expect(documentOf(again)).toEqual(original);

  // Opened again onto a board that has it already, the file's pages come
  // after the board's own, under new ids that still hold together.
  const added = toast(page, "The file's pages were added to the board.");
  await expect(added).toBeHidden();
  await openTldr(page, "table.tldr");
  await expect(added).toBeVisible();
  const doubled = documentOf(await downloadTldr(page));
  expect(doubled.pages.map((one) => one.name)).toEqual([
    "The map",
    "The table",
    "Notes",
    "The map",
    "The table",
    "Notes",
  ]);
  expect(doubled.pages.slice(0, 3)).toEqual(original.pages);
  expect(new Set(doubled.pages.map((one) => one.id)).size).toBe(6);
  expect(doubled.shapes).toHaveLength(original.shapes.length * 2);
  expect(doubled.bindings).toHaveLength(original.bindings.length * 2);
  expectWhole(doubled);

  await expectNoCspViolations(page);
  await expectNoCspViolations(guest);
  await guest.context().close();
});

test("an older .tldr dropped on the board migrates; a newer one is refused with a reason", async ({
  page,
}) => {
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Cy`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();

  await openTldr(page, "table-newer.tldr");
  await expect(
    toast(page, "This file is from a newer version of tldraw. This board cannot import it yet."),
  ).toBeVisible();

  await dropFile(page, "table-older.tldr", "");
  await expect(toast(page, "The file's pages were added to the board.")).toBeVisible();
  const opened = documentOf(await downloadTldr(page));
  const original = documentOfFile("table.tldr");
  expect(opened.pages).toEqual(original.pages);
  expect(opened.shapes.map((shape) => shape.id)).toEqual(original.shapes.map((shape) => shape.id));
  expect(opened.bindings).toEqual(original.bindings.map((binding) => ({ ...binding })));
  expect(opened.assets.map((asset) => asset.props!.src)).toEqual(
    original.assets.map((asset) => asset.props!.src),
  );
  expectWhole(opened);

  await expectNoCspViolations(page);
});

test("a large import shows progress, explains a failed upload and can be retried", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await collectCspViolations(page);
  await page.goto(`${HOST}/sign-in?name=Sid`);
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(ON_TABLETOP);
  const file = {
    buffer: Buffer.concat([readFileSync(fixture("table.tldr")), Buffer.alloc(5_000_000, " ")]),
    mimeType: "application/vnd.tldraw+json",
    name: "large.tldr",
  };
  const chooseImport = async () => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("main-menu.button").click();
    await page.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
    const picker = await chooser;
    await picker.setFiles(file);
  };

  const response = Promise.withResolvers<null>();
  await page.route("**/files", async (route) => {
    await response.promise;
    await route.fulfill({ json: { error: "over-quota" }, status: 507 });
  });
  try {
    await chooseImport();
    const progress = page.getByRole("progressbar", { name: "Images uploaded: 0 of 2" });
    const fullScreen = page.getByRole("dialog", { name: "Importing large.tldr" });
    await expect(fullScreen).toBeVisible();
    await expect(fullScreen).toContainText("Importing large.tldr");
    await expect(progress).toBeVisible();
    expect(await fullScreen.boundingBox()).toEqual({ height: 844, width: 390, x: 0, y: 0 });
    await page.keyboard.press("Escape");
    await expect(fullScreen).toBeVisible();
    await reviewShot(page, "import-phone-full-screen");

    await page.setViewportSize({ height: 900, width: 1200 });
    await expect(fullScreen).toBeHidden();
    await expect(progress).toBeVisible();
    await expect(page.getByTestId("page-menu.button")).toHaveText("Page 1");
    await reviewShot(page, "import-desktop-progress");
  } finally {
    response.resolve(null);
  }
  const failure = page
    .locator(".tlui-toast__container")
    .filter({ hasText: "Could not import “large.tldr”" });
  await expect(failure).toBeVisible();
  await expect(failure.locator(".tlui-toast__description")).toContainText(
    "This board has no room for more images.",
  );
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByTestId("page-menu.button")).toHaveText("Page 1");

  await page.unroute("**/files");
  await chooseImport();
  await expect(toast(page, "The file's pages were added to the board.")).toBeVisible();
  await expect(page.getByTestId("page-menu.button")).toHaveText("The map");
  await expectNoCspViolations(page);
});

// An image's address on another board opens only with that board's files
// cookie, which a person holds while they are on it. Pasted from another
// board's tab, or in a .tldr that points at one, the image is copied to
// this board; what this person cannot read is left out, and they are told.
test("an image from another board is copied over, or left out with a reason", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const first = await context.newPage();
  await collectCspViolations(first);
  await first.goto(`${HOST}/sign-in?name=Iris`);
  await first.getByRole("button", { name: "New board" }).click();
  await expect(first).toHaveURL(ON_TABLETOP);
  await uploadImage(first, "map.png");
  await expect.poll(() => loadedImages(first)).toEqual([expect.stringMatching(stored)]);
  const [onFirst] = await loadedImages(first);

  const second = await context.newPage();
  await collectCspViolations(second);
  await second.goto(`${HOST}/sign-in?name=Iris`);
  await second.getByRole("button", { name: "New board" }).click();
  await expect(second).toHaveURL(ON_TABLETOP);
  const guest = await phone(browser, second.url());
  await joinAs(guest, "Noor");

  // Copied on the first board and pasted on the second: tldraw embeds the
  // image in what it copies, and the second board stores its own copy,
  // which its guest, who was never on the first, sees.
  await first.bringToFront();
  await first.getByTestId("canvas").focus();
  await first.keyboard.press("ControlOrMeta+a");
  await first.keyboard.press("ControlOrMeta+c");
  // NOTE: tldraw writes the clipboard once it has embedded the images.
  let html = "";
  await expect
    .poll(async () => {
      html = await first.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        if (item?.types.includes("text/html") !== true) return "";
        const blob = await item.getType("text/html");
        return blob.text();
      });
      return html;
    })
    .toContain("data:image/png");
  await second.bringToFront();
  await second.getByTestId("canvas").focus();
  // NOTE: a headless browser does not paste from its clipboard on Ctrl+V;
  // the event carries what tldraw copied.
  await second.evaluate((content) => {
    const data = new DataTransfer();
    data.setData("text/html", content);
    document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  }, html);
  const copied = expect.stringMatching(stored);
  await expect.poll(() => loadedImages(second)).toEqual([copied]);
  const [onSecond] = await loadedImages(second);
  expect(onSecond).not.toBe(onFirst);
  await expect
    .poll(async () => {
      await zoomToFit(guest);
      return loadedImages(guest);
    })
    .toEqual([onSecond]);

  // A .tldr whose map points at the first board: the guest cannot read
  // it, so the map is left out with a reason; the portrait comes in.
  const file = JSON.parse(readFileSync(fixture("table.tldr"), "utf8")) as {
    records: { id: string; props?: { src?: string } }[];
  };
  for (const record of file.records) {
    if (record.id === "asset:map") record.props!.src = onFirst;
  }
  const pointing = { buffer: Buffer.from(JSON.stringify(file)), mimeType: "", name: "linked.tldr" };
  const chooser = guest.waitForEvent("filechooser");
  await guest.getByTestId("main-menu.button").click();
  await guest.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
  const picker = await chooser;
  await picker.setFiles(pointing);
  await expect(
    toast(
      guest,
      "An image from another board could not be brought over. Open that board, then paste again.",
    ),
  ).toBeVisible();
  // The pasted map stays; the file's own map is gone.
  const left = documentOf(await downloadTldr(guest));
  expect(left.assets.map((asset) => [asset.id, asset.props!.src])).toEqual([
    [expect.not.stringMatching(/^asset:map$/u), `sha256:${sha256(MAP)}`],
    ["asset:portrait", `sha256:${sha256(PORTRAIT)}`],
  ]);
  expectWhole(left);

  // The same file opened by the first board's owner, who is on it: its
  // map is copied over.
  const opened = second.waitForEvent("filechooser");
  await second.getByTestId("main-menu.button").click();
  await second.getByRole("menuitem", { name: "Import a .tldr file…" }).click();
  const again = await opened;
  await again.setFiles(pointing);
  await expect(toast(second, "The file's pages were added to the board.").first()).toBeVisible();
  await expect
    .poll(async () => {
      const loaded = await loadedImages(second);
      return loaded.includes(onSecond!) && !loaded.includes(onFirst!);
    })
    .toBe(true);

  for (const each of [first, second, guest]) await expectNoCspViolations(each);
  await guest.context().close();
  await context.close();
});
