import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { BoardRoom } from "../src/board-room";
import type { Roll } from "../src/dice-notation";

import { addRollColumns, rollDie } from "../src/dice";
import { call, pass, roll, seat, until } from "./support";

describe("rolling", () => {
  it("shows every seat the same dice and keeps them in the log", async () => {
    const ania = await seat("dice", await pass({ board: "dice" }));
    const guest = await seat("dice", await pass({ board: "dice", name: "Guest", sub: "g:1" }));

    const response = await roll("dice", await pass({ board: "dice" }), [6, 6, 20]);
    const rolled: Roll = await response.json();

    expect(rolled.dice.map((die) => die.sides)).toEqual([6, 6, 20]);
    expect(rolled.name).toBe("Ania");
    for (const person of [ania, guest]) {
      await until(() => person.received.some((message) => message.type === "custom"));
      expect(person.received.find((message) => message.type === "custom")?.data).toEqual({
        roll: rolled,
        type: "roll",
      });
    }
    const log = await call("/rooms/dice/rolls", await pass({ board: "dice", sub: "g:1" }));
    expect(await log.json()).toEqual([rolled]);
  });

  it("records a notation roll once, in group order, and sends it to each seat", async () => {
    const board = "notation";
    const token = await pass({ board });
    const ania = await seat(board, token);
    const guest = await seat(board, await pass({ board, name: "Guest", sub: "g:1" }));
    const expression = "3k6kh2 + d20 - 2";
    const response = await call(`/rooms/${board}/roll`, token, {
      body: JSON.stringify({ expression }),
      method: "POST",
    });
    expect(response.status).toBe(200);
    const rolled: Roll = await response.json();
    expect(rolled.expression).toBe(expression);
    expect(rolled.dice.map((die) => die.sides)).toEqual([6, 6, 6, 20]);
    for (const person of [ania, guest]) {
      await until(() => person.received.some((message) => message.type === "custom"));
      expect(person.received.find((message) => message.type === "custom")?.data).toEqual({
        roll: rolled,
        type: "roll",
      });
    }
    const log = await call(`/rooms/${board}/rolls`, token);
    expect(await log.json()).toEqual([rolled]);
  });

  it("rejects invalid notation without falling back to dice or creating a log entry", async () => {
    const board = "bad-notation";
    const token = await pass({ board });
    const response = await call(`/rooms/${board}/roll`, token, {
      body: JSON.stringify({ dice: [6], expression: "3d6kh4" }),
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "rule" });
    const log = await call(`/rooms/${board}/rolls`, token);
    expect(await log.json()).toEqual([]);
  });

  it.each([
    ["no dice", []],
    ["too many dice", Array.from({ length: 21 }, () => 6)],
    ["a die that does not exist", [7]],
    ["something that is not a pool", "2d6"],
  ])("refuses %s", async (_label, dice) => {
    const response = await roll("bad", await pass({ board: "bad" }), dice);
    expect(response.status).toBe(400);
    const log = await call("/rooms/bad/rolls", await pass({ board: "bad" }));
    expect(await log.json()).toEqual([]);
  });

  it("gives each roll its own unsigned 32-bit seed", async () => {
    const seeds: unknown[] = [];
    for (let person = 0; person < 6; person++) {
      const response = await roll(
        "seeds",
        await pass({ board: "seeds", sub: `u:${person}` }),
        [20],
      );
      seeds.push(((await response.json()) as Roll).seed);
    }
    for (const seed of seeds) {
      expect(Number.isInteger(seed) && (seed as number) >= 0 && (seed as number) < 2 ** 32).toBe(
        true,
      );
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("still loads a log from before seeds and notation", async () => {
    const board = "before-seeds";
    const token = await pass({ board });
    await roll(board, token, [6]);
    const namespace = (env as unknown as { BoardRoom: DurableObjectNamespace<BoardRoom> })
      .BoardRoom;
    const room = namespace.get(namespace.idFromName(board));
    await runInDurableObject(room, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec("DELETE FROM rolls");
      sql.exec("ALTER TABLE rolls DROP COLUMN seed");
      sql.exec("ALTER TABLE rolls DROP COLUMN expression");
      sql.exec(
        "INSERT INTO rolls (at, sub, name, dice) VALUES (1, 'u:9', 'Old', '[{\"sides\":6,\"value\":4}]')",
      );
      addRollColumns(sql);
      addRollColumns(sql);
    });
    const log = await call(`/rooms/${board}/rolls`, token);
    expect(await log.json()).toEqual([
      {
        at: 1,
        dice: [{ sides: 6, value: 4 }],
        id: expect.any(Number),
        name: "Old",
        seed: null,
        sub: "u:9",
      },
    ]);
    const next = await roll(board, await pass({ board, sub: "u:2" }), [8]);
    expect(((await next.json()) as Roll).seed).toEqual(expect.any(Number));
  });

  it("refuses a second roll from the same person in the same instant", async () => {
    const token = await pass({ board: "fast" });
    expect((await roll("fast", token, [6])).status).toBe(200);
    expect((await roll("fast", token, [6])).status).toBe(429);
  });

  it("keeps only the latest fifty rolls", async () => {
    for (let person = 0; person < 52; person++) {
      await roll("long", await pass({ board: "long", sub: `u:${person}` }), [4]);
    }
    const log = await call("/rooms/long/rolls", await pass({ board: "long" }));
    const rolls: Roll[] = await log.json();
    expect(rolls.map((entry) => entry.sub)).toEqual(
      Array.from({ length: 50 }, (_, index) => `u:${index + 2}`),
    );
  });
});

describe("a die", () => {
  it.each([4, 6, 8, 10, 12, 20, 100])("with %i sides shows each face and no other", (sides) => {
    const faces = new Set(Array.from({ length: sides * 200 }, () => rollDie(sides)));
    expect([...faces].sort((a, b) => a - b)).toEqual(
      Array.from({ length: sides }, (_, index) => index + 1),
    );
  });
});
