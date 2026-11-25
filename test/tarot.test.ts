import { describe, expect, it } from "vitest";

import { call, pass } from "./support";

function draw(board: string, token: string, payload: Record<string, unknown> = {}) {
  return call(`/rooms/${board}/tarot`, token, {
    body: JSON.stringify({
      height: 250,
      id: crypto.randomUUID(),
      language: "en",
      page: "page:page",
      x: 200,
      y: 200,
      ...payload,
    }),
    method: "POST",
  });
}

async function revealed(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json<{ name: string }>()).name;
}

describe("the board's tarot deck", () => {
  it("draws each face once across simultaneous draws, then shuffles a fresh deck", async () => {
    const board = "tarot-full";
    const owner = await pass({ board, owner: true });
    const id = crypto.randomUUID();
    const first = await revealed(await draw(board, owner, { id }));
    const retry = await revealed(await draw(board, owner, { id }));
    expect(retry).toBe(first);

    const names = [first];
    for (let batch = 0; batch < 11; batch++) {
      const responses = await Promise.all(Array.from({ length: 7 }, () => draw(board, owner)));
      names.push(...(await Promise.all(responses.map(revealed))));
    }
    expect(new Set(names).size).toBe(78);
    expect(names).toEqual(expect.arrayContaining(["The Fool", "Queen of Wands", "Ace of Cups"]));
    expect(names).toContain(await revealed(await draw(board, owner)));
  });

  it("rejects guests, stale passes and missing pages", async () => {
    const board = "tarot-admission";
    const guest = await pass({ board });
    expect((await draw(board, guest)).status).toBe(403);
    const owner = await pass({ board, link: 1, owner: true });
    expect((await draw(board, owner, { page: "page:missing" })).status).toBe(409);
    expect((await draw(board, owner, { height: -5 })).status).toBe(400);
    const stale = await pass({ board, owner: true });
    expect((await draw(board, stale)).status).toBe(403);
  });
});
