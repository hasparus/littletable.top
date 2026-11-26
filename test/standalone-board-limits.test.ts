import type { TLRecord } from "@tldraw/tlschema";

import { DurableObjectSqliteSyncWrapper, SQLiteSyncStorage } from "@tldraw/sync-core";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

import { MAX_BOARDS_PER_ACCOUNT, MAX_BOARDS_PER_HOUR } from "../src/limits";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const now = () => Math.floor(Date.now() / 1000);

function create(browser: Browser, deployment = "", language = "en") {
  return browser.fetch(
    "/api/boards",
    {
      body: JSON.stringify({ language, title: "Map" }),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": browser.csrf!,
      },
      method: "POST",
    },
    { ...standaloneEnv, BOARD_DATA_SCOPE: deployment },
  );
}

async function seed(browser: Browser, count: number, createdAt: number) {
  const { account } = await (await browser.fetch("/api/me")).json<{ account: { id: string } }>();
  await standaloneEnv
    .DB!.prepare(
      `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?1)
       INSERT INTO boards (id, owner_id, title, share_code, created_at)
       SELECT ?2 || '-' || n, ?2, 'Existing board', ?2 || '-link-' || n, ?3 FROM sequence`,
    )
    .bind(count, account.id, createdAt)
    .run();
}

it("allows only one concurrent creation at the account cap", async () => {
  const owner = new Browser();
  await owner.signIn("Ada");
  await seed(owner, MAX_BOARDS_PER_ACCOUNT - 1, now() - 7200);

  const responses = await Promise.all(Array.from({ length: 4 }, () => create(owner)));
  expect(responses.map(({ status }) => status).sort()).toEqual([201, 409, 409, 409]);
  for (const response of responses) {
    if (response.status === 409)
      expect(await response.json()).toEqual({ error: "too-many-boards" });
  }
  expect((await owner.list()).owned).toHaveLength(MAX_BOARDS_PER_ACCOUNT);
  expect((await create(owner, "quota-preview")).status).toBe(201);
});

it("keeps concurrent creations within the rolling hour even after deletion", async () => {
  const owner = new Browser();
  const other = new Browser();
  await owner.signIn("Ada");
  await other.signIn("Bea");
  const timestamp = now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
  try {
    await seed(owner, MAX_BOARDS_PER_HOUR - 1, timestamp - 3599);

    const responses = await Promise.all(Array.from({ length: 4 }, () => create(owner)));
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 429, 429, 429]);
    const { id } = await responses.find(({ status }) => status === 201)!.json<{ id: string }>();
    expect((await owner.post(`/api/boards/${id}/delete`)).status).toBe(204);
    const retry = await create(owner);
    expect(retry.status).toBe(429);
    expect(await retry.json()).toEqual({ error: "too-many-requests" });

    expect((await create(other)).status).toBe(201);
    expect((await create(owner, "quota-preview")).status).toBe(201);
    clock.mockReturnValue((timestamp + 1) * 1000);
    expect((await create(owner)).status).toBe(201);
  } finally {
    clock.mockRestore();
  }
});

it("initializes a Polish board on a retried bootstrap without creating a second board", async () => {
  const owner = new Browser();
  await owner.signIn("Ada");
  const response = await create(owner, "", "pl");
  expect(response.status).toBe(201);
  const { id, shareCode } = await response.json<{ id: string; shareCode: string }>();
  const { BoardRoom } = standaloneEnv;
  const stub = BoardRoom.get(BoardRoom.idFromName(id));
  await runInDurableObject(stub, (room) => {
    const prototype = Object.getPrototypeOf(room) as { openDrawing: () => unknown };
    vi.spyOn(prototype, "openDrawing").mockImplementationOnce(() => {
      throw new Error("Drawing unavailable");
    });
  });

  await expect(owner.bootstrap(shareCode)).rejects.toThrow("Drawing unavailable");
  expect((await owner.bootstrap(shareCode)).status).toBe(200);
  expect((await owner.list()).owned.map((board) => board.id)).toEqual([id]);
  await runInDurableObject(stub, (_room, state) => {
    const sql = new DurableObjectSqliteSyncWrapper(state.storage, { tablePrefix: "tldraw_" });
    const drawing = new SQLiteSyncStorage<TLRecord>({ sql });
    drawing.transaction((store) => {
      expect([...store.values()].filter((record) => record.typeName === "page")).toMatchObject([
        { name: "Strona 1" },
      ]);
    });
  });
});
