import { PhotonImage } from "@cf-wasm/photon/node";
import { expect, test } from "@playwright/test";

import { SHARE_ART_WINDOW } from "../../src/share-art";
import { boardAt, STANDALONE } from "../ports";
import { putNote } from "./helpers";

test("a link preview includes the drawing as soon as the board has a thumbnail", async ({
  page,
  request,
}) => {
  await page.goto(`${STANDALONE}/boards`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Name").fill("Sample account");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await expect(page).toHaveURL(boardAt(STANDALONE));
  await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
  const board = page.url();
  const before = await request.get(board);
  expect(await before.text()).toContain(
    `property="og:image" content="${STANDALONE}/open-graph.png"`,
  );

  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/thumbnail") && response.request().method() === "PUT",
  );
  await putNote(page, { at: { x: 230, y: 220 }, text: "The observatory" });
  const capture = await saved;
  expect(capture.status()).toBe(204);

  const response = await request.get(board);
  expect(await response.text()).toContain(`property="og:image" content="${board}/preview.png"`);
  const image = await request.get(`${board}/preview.png`);
  expect(image.headers()["cache-control"]).toBe("no-store");
  expect(image.headers()["content-type"]).toMatch(/^image\/png/u);
  const composed = PhotonImage.new_from_byteslice(await image.body());
  try {
    expect([composed.get_width(), composed.get_height()]).toEqual([1200, 630]);
    const { left, top, width } = SHARE_ART_WINDOW;
    const pixels = composed.get_raw_pixels();
    expect(pixels.slice(0, 4)).toEqual(Uint8Array.of(247, 246, 243, 255));
    const besideDrawing = (top * 1200 + left) * 4;
    expect(pixels.slice(besideDrawing, besideDrawing + 4)).toEqual(
      Uint8Array.of(247, 246, 243, 255),
    );
    const at = ((top + 40) * 1200 + left + width / 2) * 4;
    const [red, green, blue] = pixels.slice(at, at + 3);
    expect(red).toBeGreaterThan(200);
    expect(green).toBeGreaterThan(160);
    expect(blue).toBeLessThan(180);
  } finally {
    composed.free();
  }
});
