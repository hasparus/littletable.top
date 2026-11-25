import { expect, it } from "vitest";

import { IMAGES_37_BY_21 } from "./image-samples";
import { Browser, ORIGIN } from "./standalone-support";

const png = IMAGES_37_BY_21["size.png"];

it("lets only the owner publish, update, and withdraw a separate public snapshot", async () => {
  const owner = new Browser();
  const visitor = new Browser();
  const reader = new Browser();
  await owner.signIn("Owner");
  await visitor.signIn("Visitor");
  const board = await owner.createBoard();
  const path = `/api/boards/${board.id}/publish`;
  const publish = (browser: Browser, body = png, origin = ORIGIN) =>
    browser.fetch(path, {
      body,
      headers: {
        "Content-Type": "image/png",
        Origin: origin,
        "X-CSRF-Token": browser.csrf ?? "",
      },
      method: "POST",
    });

  expect(await (await owner.bootstrap(board.shareCode)).json()).toMatchObject({
    publication: { csrf: owner.csrf, url: null },
  });
  expect(await (await visitor.bootstrap(board.shareCode)).json()).not.toHaveProperty("publication");
  expect((await publish(visitor)).status).toBe(404);
  expect((await publish(reader)).status).toBe(401);
  expect((await publish(owner, png, "https://other.test")).status).toBe(403);
  expect((await publish(owner, IMAGES_37_BY_21["size-lossy.webp"])).status).toBe(415);

  const first = await publish(owner);
  expect(first.status).toBe(200);
  const { url } = (await first.json()) as { url: string };
  expect(await (await publish(owner)).json()).toEqual({ url });
  expect(await (await owner.bootstrap(board.shareCode)).json()).toMatchObject({
    publication: { url },
  });
  const shared = await reader.fetch(url);
  expect(shared.status).toBe(200);
  expect(shared.headers.get("Content-Type")).toBe("image/png");
  expect(shared.headers.get("Cache-Control")).toBe("no-store");
  expect(new Uint8Array(await shared.arrayBuffer())).toEqual(png);

  expect(
    (
      await owner.fetch(path, {
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "X-CSRF-Token": owner.csrf!,
        },
        method: "DELETE",
      })
    ).status,
  ).toBe(204);
  expect((await reader.fetch(url)).status).toBe(404);
  const fresh = (await (await publish(owner)).json()) as { url: string };
  expect(fresh.url).not.toBe(url);
  expect((await reader.fetch(url)).status).toBe(404);
  expect((await owner.post(`/api/boards/${board.id}/delete`)).status).toBe(204);
  expect((await reader.fetch(fresh.url)).status).toBe(404);
});
