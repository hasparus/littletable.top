import { PhotonImage } from "@cf-wasm/photon/workerd";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import {
  THUMBNAIL_BACKGROUND_HEADER,
  THUMBNAIL_INTERVAL_MS,
  thumbnailUrl,
} from "../src/board-thumbnail";
import { SHARE_ART, SHARE_ART_WINDOW } from "../src/share-art";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

function toPng(bytes: Uint8Array, width: number, height: number) {
  const image = new PhotonImage(bytes, width, height);
  try {
    return Uint8Array.from(image.get_bytes());
  } finally {
    image.free();
  }
}

function expectCardPixels(bytes: ArrayBuffer, background: number[]) {
  const composition = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
  try {
    expect([composition.get_width(), composition.get_height()]).toEqual([1200, 630]);
    const pixels = composition.get_raw_pixels();
    const { height, left, top, width } = SHARE_ART_WINDOW;
    const leftSample = ((top + height / 2) * 1200 + left + width / 4) * 4;
    const rightSample = leftSample + (width / 2) * 4;
    expect([...pixels.slice(0, 4)]).toEqual([37, 34, 32, 255]);
    expect([...pixels.slice(4, 8)]).toEqual(background);
    expect([...pixels.slice(leftSample, leftSample + 4)]).toEqual(background);
    expect([...pixels.slice(rightSample, rightSample + 4)]).toEqual([255, 0, 0, 255]);
  } finally {
    composition.free();
  }
}

it("automatically composes a drawing for the current share link only", async () => {
  const owner = new Browser();
  const crawler = new Browser();
  await owner.signIn("Owner");
  const board = await owner.createBoard("A red map");
  const page = `/b/${board.shareCode}`;
  const card = `${page}/preview.png`;
  const artwork = new Uint8Array(1200 * 630 * 4);
  artwork.set([37, 34, 32, 255]);
  const template = toPng(artwork, 1200, 630);
  const drawing = toPng(new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255]), 2, 1);
  const env = {
    ...standaloneEnv,
    ASSETS: {
      fetch(url: URL, init?: RequestInit) {
        if (url.pathname === SHARE_ART) {
          return Promise.resolve(new Response(template, { headers: { ETag: '"plain"' } }));
        }
        if (url.pathname === "/open-graph.png") {
          return Promise.resolve(new Response(init?.method === "HEAD" ? null : "Generic PNG"));
        }
        return standaloneEnv.ASSETS.fetch(url, init);
      },
    } as Fetcher,
  };

  expect(await (await crawler.fetch(page, {}, env)).text()).toContain(
    `property="og:image" content="${ORIGIN}/open-graph.png"`,
  );
  expect(await (await crawler.fetch(card, {}, env)).text()).toBe("Generic PNG");

  const upload = (background: string | null = null) =>
    owner.fetch(thumbnailUrl(board.id), {
      body: drawing,
      headers: {
        "Content-Type": "image/png",
        Origin: ORIGIN,
        "X-Board-Link": "0",
        "X-CSRF-Token": owner.csrf!,
        ...(background === null ? {} : { [THUMBNAIL_BACKGROUND_HEADER]: background }),
      },
      method: "PUT",
    });
  expect((await upload()).status).toBe(204);
  expect((await crawler.fetch(thumbnailUrl(board.id))).status).toBe(404);
  expect(await (await crawler.fetch(page, {}, env)).text()).toContain(
    `property="og:image" content="${ORIGIN}${card}"`,
  );

  const image = await crawler.fetch(card, {}, env);
  expect(image.headers.get("Cache-Control")).toBe("no-store");
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expectCardPixels(await image.arrayBuffer(), [247, 246, 243, 255]);

  // A color change produces a new card even when the thumbnail bytes and ETag are unchanged.
  const { BoardRoom: rooms } = standaloneEnv;
  const room = rooms.get(rooms.idFromName(board.id));
  await runInDurableObject(room, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE thumbnail SET updated_at = ?",
      Date.now() - THUMBNAIL_INTERVAL_MS,
    );
  });
  expect((await upload("#e6eff9")).status).toBe(204);
  const colored = await crawler.fetch(card, {}, env);
  const bytes = await colored.arrayBuffer();
  expectCardPixels(bytes, [230, 239, 249, 255]);

  expect(await (await crawler.fetch(card, {}, env)).arrayBuffer()).toEqual(bytes);
  const head = await crawler.fetch(card, { method: "HEAD" }, env);
  expect(head.body).toBeNull();

  const reset = await owner.post(`/api/boards/${board.id}/reset`);
  expect(reset.status).toBe(200);
  const changed = (await reset.json()) as { shareCode: string };
  for (const code of [board.id, board.shareCode]) {
    expect(await (await crawler.fetch(`/b/${code}/preview.png`, {}, env)).text()).toBe(
      "Generic PNG",
    );
  }
  const currentCard = `/b/${changed.shareCode}/preview.png`;
  expect(await (await crawler.fetch(currentCard, {}, env)).arrayBuffer()).toEqual(bytes);
  expect((await owner.post(`/api/boards/${board.id}/delete`)).status).toBe(204);
  expect(await (await crawler.fetch(currentCard, {}, env)).text()).toBe("Generic PNG");
});
