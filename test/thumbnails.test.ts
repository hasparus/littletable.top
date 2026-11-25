import { expect, it } from "vitest";

import { THUMBNAIL_MAX_BYTES, THUMBNAIL_TYPE, thumbnailUrl } from "../src/board-thumbnail";
import { thumbnailKey } from "../src/thumbnail-store";
import { IMAGES_37_BY_21 } from "./image-samples";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const image = IMAGES_37_BY_21["size-lossless.webp"];

function put(
  browser: Browser,
  path: string,
  link: number,
  body = image,
  headers: HeadersInit = {},
) {
  return browser.fetch(path, {
    body,
    headers: {
      "Content-Type": THUMBNAIL_TYPE,
      Origin: ORIGIN,
      "X-Board-Link": String(link),
      "X-CSRF-Token": browser.csrf ?? "",
      ...headers,
    },
    method: "PUT",
  });
}

it("keeps one bounded thumbnail visible to the owner and current members only", async () => {
  const owner = new Browser();
  const visitor = new Browser();
  const guest = new Browser();
  await owner.signIn("Ada");
  await visitor.signIn("Bea");
  const board = await owner.createBoard();
  const path = thumbnailUrl(board.id);
  const ownerBootstrap = await (await owner.bootstrap(board.shareCode)).json();
  expect(ownerBootstrap).toMatchObject({ thumbnail: { csrf: owner.csrf, link: 0, needed: true } });
  const guestBootstrap = await (await guest.bootstrap(board.shareCode, { name: "Guest" })).json();
  expect(guestBootstrap).not.toHaveProperty("thumbnail");
  expect(await (await owner.post("/api/public-board/bootstrap")).json()).not.toHaveProperty(
    "thumbnail",
  );

  expect((await visitor.fetch(path)).status).toBe(404);
  expect((await put(visitor, path, 0)).status).toBe(404);
  expect((await put(guest, path, 0)).status).toBe(401);
  expect((await put(owner, path, 0, image, { Origin: "https://other.test" })).status).toBe(403);
  expect((await put(owner, path, 0, image, { "X-CSRF-Token": "wrong" })).status).toBe(403);
  expect((await put(owner, path, 0, new Uint8Array(THUMBNAIL_MAX_BYTES + 1))).status).toBe(413);
  expect((await put(owner, path, 0, IMAGES_37_BY_21["size.png"])).status).toBe(415);

  expect((await put(owner, path, 0)).status).toBe(204);
  expect((await owner.list()).owned[0]).toMatchObject({ hasThumbnail: true });
  expect(await (await owner.bootstrap(board.shareCode)).json()).toMatchObject({
    thumbnail: { needed: false },
  });
  const before = await owner.fetch(path);
  expect(before.status).toBe(200);
  expect(before.headers.get("Cache-Control")).toBe("no-store");
  expect(before.headers.get("Content-Type")).toBe(THUMBNAIL_TYPE);
  expect(new Uint8Array(await before.arrayBuffer())).toEqual(image);

  const tooFast = await put(owner, path, 0, IMAGES_37_BY_21["size-lossy.webp"]);
  expect(tooFast.status).toBe(429);
  expect(Number(tooFast.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect((await guest.fetch(path)).status).toBe(404);
  expect((await visitor.fetch(path)).status).toBe(404);

  expect((await visitor.bootstrap(board.shareCode)).status).toBe(200);
  expect((await visitor.list()).visited[0]).toMatchObject({ hasThumbnail: true });
  expect((await visitor.fetch(path)).status).toBe(200);

  const reset = await owner.post(`/api/boards/${board.id}/reset`);
  const renewed = (await reset.json()) as { shareCode: string };
  expect(reset.status).toBe(200);
  expect((await visitor.fetch(path)).status).toBe(404);
  expect((await owner.fetch(path)).status).toBe(200);
  expect((await put(visitor, path, 0)).status).toBe(404);
  expect((await visitor.list()).visited[0]).not.toHaveProperty("hasThumbnail");
  expect((await visitor.bootstrap(renewed.shareCode)).status).toBe(200);
  expect((await visitor.fetch(path)).status).toBe(200);

  expect((await owner.post(`/api/boards/${board.id}/delete`)).status).toBe(204);
  expect((await owner.fetch(path)).status).toBe(404);
  expect((await put(owner, path, 1)).status).toBe(404);
  expect(await standaloneEnv.Files.head(thumbnailKey(board.id))).toBeNull();
});
