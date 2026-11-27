import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src";

import { MAX_PEOPLE } from "../src/limits";
import { call, now, open, pass, seat, until } from "./support";

describe("a pass", () => {
  it("opens the board it names", async () => {
    const { response } = await open("b1", await pass());
    expect(response.status).toBe(101);
  });

  it.each([
    ["for another board", () => pass({ board: "b2" })],
    ["for another service", () => pass({ audience: "chat" })],
    ["that expired", () => pass({ issuedAt: now() - 3_600 })],
    ["that is not a token", async () => "nonsense"],
  ])("%s is refused", async (_label, token) => {
    const { response } = await open("b1", await token());
    expect(response.status).toBe(403);
  });

  it("is required", async () => {
    expect((await call("/rooms/b1/rolls", null)).status).toBe(403);
  });
});

describe("resetting the link", () => {
  it("puts out everyone who came in by the old link and keeps them out", async () => {
    const guest = await seat("reset", await pass({ board: "reset", sub: "g:1" }));
    const owner = await seat("reset", await pass({ board: "reset", link: 1, owner: true }));

    await until(guest.isClosed);
    expect(owner.isClosed()).toBe(false);
    expect((await call("/rooms/reset/rolls", await pass({ board: "reset" }))).status).toBe(403);
  });
});

describe("a refusal on the socket", () => {
  it("tells a person from a reset link why, in a way the browser can read", async () => {
    await seat("gone", await pass({ board: "gone", link: 1, owner: true }));
    const { closure, response } = await open("gone", await pass({ board: "gone", sub: "g:1" }));

    expect(response.status).toBe(101);
    expect(await closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.FORBIDDEN,
    });
  });

  it("gives a member a separate session when signing in from a guest's tab", async () => {
    const board = "signed-in-tab";
    const tabId = crypto.randomUUID();
    const guest = await seat(board, await pass({ board, sub: "g:visitor" }), tabId, "guest-store");
    const memberPass = await pass({ board, sub: "u:member" });
    const member = await seat(board, memberPass, tabId, "member-store");
    const reloaded = await seat(board, memberPass, tabId);

    expect(await member.closure).toEqual({ code: 1012, reason: "Session replaced" });
    expect(guest.isClosed()).toBe(false);
    guest.close();
    reloaded.close();
  });

  it("reclaims a seat saved by the previous tab-only protocol after hibernation", async () => {
    const board = "legacy-seat";
    const tab = crypto.randomUUID();
    const token = await pass({ board });
    const original = await seat(board, token, tab);
    const { BoardRoom } = env as unknown as Env;
    const room = BoardRoom.get(BoardRoom.idFromName(board));
    await runInDurableObject(room, (_instance, state) => {
      const [socket] = state.getWebSockets();
      const saved = socket!.deserializeAttachment();
      socket!.serializeAttachment({ ...saved, sessionId: tab });
    });
    await evictDurableObject(room, { webSockets: "hibernate" });

    const replacement = await seat(board, token, tab, "new-store");
    expect(await original.closure).toEqual({ code: 1012, reason: "Session replaced" });
    replacement.close();
  });

  it("keeps a full board at capacity while the same player reclaims their seat", async () => {
    const sessionId = crypto.randomUUID();
    const returningToken = await pass({ board: "full", sub: "u:returning" });
    const strangerToken = await pass({ board: "full", sub: "u:late" });
    const original = await seat("full", returningToken, sessionId);
    const seated = [];
    for (let person = 1; person < MAX_PEOPLE; person++) {
      seated.push(await seat("full", await pass({ board: "full", sub: `u:${person}` })));
    }

    const newcomer = await open("full", strangerToken, sessionId);
    expect(await newcomer.closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.ROOM_FULL,
    });
    expect(original.isClosed()).toBe(false);

    const replacement = await seat("full", returningToken, sessionId, "new-store");
    expect(await original.closure).toEqual({ code: 1012, reason: "Session replaced" });

    const backWithoutStore = await seat("full", returningToken, sessionId);
    expect(await replacement.closure).toEqual({ code: 1012, reason: "Session replaced" });

    const late = await open("full", strangerToken);

    expect(late.response.status).toBe(101);
    expect(await late.closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.ROOM_FULL,
    });
    expect(seated.some((person) => person.isClosed())).toBe(false);
    backWithoutStore.send({ type: "ping" });
    await until(() => backWithoutStore.received.some((message) => message.type === "pong"));
    for (const person of [backWithoutStore, ...seated]) person.close();
  });
});
