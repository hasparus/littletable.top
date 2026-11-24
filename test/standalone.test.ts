import {
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import {
  AssetRecordType,
  createBindingId,
  createShapeId,
  PageRecordType,
  type TLArrowBinding,
  type TLArrowShape,
  type TLGroupShape,
  type TLImageAsset,
  type TLImageShape,
  type TLRecord,
  toRichText,
} from "@tldraw/tlschema";
import { getIndexAbove, ZERO_INDEX_KEY } from "@tldraw/utils";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";
import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

import { fileKey, textKey } from "../src/file-store";
import { saveArrowEndpoints } from "../src/public-arrow-endpoints";
import { PUBLIC_SWEEP_MS, stampPublicShape } from "../src/public-board-expiry";
import { Browser, openSocket, roomCall, standaloneEnv } from "./standalone-support";
import { pass as hostedPass } from "./support";

type Answer = { board: string; pass: string; person: { id: string; name: string; owner: boolean } };

const hostedEnv = env as unknown as Env;

describe("the public board", () => {
  it("fades and expires shapes independently on its recurring alarm", async () => {
    const guest = new Browser();
    const initial = await guest.post("/api/public-board/bootstrap");
    expect(initial.status).toBe(200);
    const { board, pass } = (await initial.json()) as Answer;
    const namespace = standaloneEnv.BoardRoom;
    const room = namespace.get(namespace.idFromName(board));
    const alarmOf = () => runInDurableObject(room, (_room, state) => state.storage.getAlarm());
    const firstAlarm = await alarmOf();
    expect(firstAlarm).toBeGreaterThan(Date.now());
    expect(firstAlarm! % PUBLIC_SWEEP_MS).toBe(0);

    const now = Date.now();
    const day = 4 * PUBLIC_SWEEP_MS;
    const page = PageRecordType.createId("page");
    const group = (name: string, overrides: Partial<TLGroupShape> = {}): TLGroupShape => ({
      id: createShapeId(name),
      index: ZERO_INDEX_KEY,
      isLocked: false,
      meta: {},
      opacity: 1,
      parentId: page,
      props: {},
      rotation: 0,
      type: "group",
      typeName: "shape",
      x: 0,
      y: 0,
      ...overrides,
    });
    const expired = stampPublicShape(group("expired", { x: 100, y: 30 }), now - 2 * day - 1);
    const faded = stampPublicShape(
      group("faded", { index: getIndexAbove(expired.index) }),
      now - day - 1,
    );
    const recent = stampPublicShape(group("recent", { parentId: expired.id, x: 2, y: 3 }), now);
    const faint = stampPublicShape(group("faint", { opacity: 0.2 }), now - day - 1);

    const arrow: TLArrowShape = {
      ...group("arrow"),
      props: {
        arrowheadEnd: "arrow",
        arrowheadStart: "none",
        bend: 0,
        color: "black",
        dash: "draw",
        elbowMidPoint: 0.5,
        end: { x: 2, y: 0 },
        fill: "none",
        font: "draw",
        kind: "arc",
        labelColor: "black",
        labelPosition: 0.5,
        richText: toRichText(""),
        scale: 1,
        size: "m",
        start: { x: 0, y: 0 },
      },
      type: "arrow",
    };
    const endpoint = { x: 98, y: 30 };
    const anchored = stampPublicShape(
      { ...arrow, meta: saveArrowEndpoints(arrow, { end: endpoint })! },
      now,
    );
    const binding: TLArrowBinding = {
      fromId: arrow.id,
      id: createBindingId("expired-target"),
      meta: {},
      props: {
        isExact: false,
        isPrecise: false,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        snap: "none",
        terminal: "end",
      },
      toId: expired.id,
      type: "arrow",
      typeName: "binding",
    };

    const hashes = { expired: "a".repeat(64), shared: "b".repeat(64) };
    const imageAsset = (name: string, hash: string): TLImageAsset => ({
      id: AssetRecordType.createId(name),
      meta: {},
      props: {
        h: 20,
        isAnimated: false,
        mimeType: "image/png",
        name,
        src: `/rooms/${board}/files/${hash}`,
        w: 20,
      },
      type: "image",
      typeName: "asset",
    });
    const orphan = imageAsset("orphan", hashes.expired);
    const held = imageAsset("held", hashes.shared);
    const image = (name: string, assetId: TLImageAsset["id"]): TLImageShape => ({
      ...group(name),
      props: {
        altText: "",
        assetId,
        crop: null,
        flipX: false,
        flipY: false,
        h: 20,
        playing: true,
        url: "",
        w: 20,
      },
      type: "image",
    });
    const expiredImage = stampPublicShape(image("expired-image", orphan.id), now - 2 * day - 1);
    const oldSharedImage = stampPublicShape(image("old-shared-image", held.id), now - 2 * day - 1);
    const newSharedImage = stampPublicShape(image("new-shared-image", held.id), now);
    const drawing = (state: DurableObjectState) =>
      new SQLiteSyncStorage<TLRecord>({
        sql: new DurableObjectSqliteSyncWrapper(state.storage, { tablePrefix: "tldraw_" }),
      });
    await runInDurableObject(room, (_room, state) => {
      drawing(state).transaction((store) => {
        for (const record of [
          expired,
          faded,
          recent,
          faint,
          anchored,
          binding,
          orphan,
          held,
          expiredImage,
          oldSharedImage,
          newSharedImage,
        ]) {
          store.set(record.id, record);
        }
      });
      for (const hash of Object.values(hashes)) {
        state.storage.sql.exec(
          "INSERT INTO files (hash, bytes, type, at) VALUES (?, 10, 'image/png', ?)",
          hash,
          now,
        );
        state.storage.sql.exec(
          "INSERT INTO texts (hash, engine, bytes, words, at) VALUES (?, 'tesseract-6.0.1', 5, 1, ?)",
          hash,
          now,
        );
      }
    });

    const rolled = await roomCall(`/rooms/${board}/roll`, pass, {
      body: JSON.stringify({ dice: [6] }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(rolled.ok).toBe(true);
    const bucket = standaloneEnv.Files;
    const imageKey = fileKey(board, hashes.expired);
    const orphanText = textKey(board, hashes.expired, "tesseract-6.0.1");
    for (const hash of Object.values(hashes)) {
      await bucket.put(fileKey(board, hash), "an image");
      await bucket.put(textKey(board, hash, "tesseract-6.0.1"), "{}");
    }

    // An alarm can be retried. The second pass must leave faded shapes unchanged.
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await alarmOf()).toBeGreaterThan(Date.now());
    await runInDurableObject(room, (_room, state) => {
      drawing(state).transaction((store) => {
        expect(store.get(expired.id)).toBeUndefined();
        expect(store.get(faded.id)).toMatchObject({ meta: faded.meta, opacity: 0.5 });
        expect(store.get(faint.id)).toEqual(faint);
        expect(store.get(recent.id)).toMatchObject({
          meta: recent.meta,
          opacity: 1,
          parentId: page,
          x: 102,
          y: 33,
        });
        expect(store.get(page)).toBeDefined();
        expect(store.get(binding.id)).toBeUndefined();
        expect(store.get(arrow.id)).toMatchObject({ props: { end: endpoint } });
        expect(store.get(orphan.id)).toBeDefined();
      });
    });

    expect(await bucket.head(imageKey)).not.toBeNull();
    await runInDurableObject(room, (_room, state) => {
      state.storage.sql.exec(
        "UPDATE files SET unused_at = ? WHERE hash = ?",
        now - PUBLIC_SWEEP_MS - 1,
        hashes.expired,
      );
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await bucket.head(imageKey)).toBeNull();
    expect(await bucket.head(orphanText)).toBeNull();
    expect(await bucket.head(fileKey(board, hashes.shared))).not.toBeNull();
    await runInDurableObject(room, (_room, state) => {
      const { sql } = state.storage;
      expect(sql.exec("SELECT hash FROM files").toArray()).toEqual([{ hash: hashes.shared }]);
      expect(sql.exec("SELECT hash FROM texts").toArray()).toEqual([{ hash: hashes.shared }]);
      drawing(state).transaction((store) => {
        expect(store.get(orphan.id)).toBeUndefined();
        expect(store.get(held.id)).toBeDefined();
      });
    });
    const history = await roomCall(`/rooms/${board}/rolls`, pass);
    expect(await history.json()).toHaveLength(1);
    expect((await openSocket(board, pass)).response.status).toBe(101);
    expect((await guest.post(`/rooms/${board}/delete`)).status).toBe(404);
  });
});

describe("signing in", () => {
  it("makes an account and a session from the provider's answer", async () => {
    const ada = new Browser();
    await ada.signIn("Ada Lovelace");

    const me = await (await ada.fetch("/api/me")).json();

    expect(me).toEqual({
      account: {
        avatar: expect.stringMatching(/^\/api\/avatars\/[0-9a-f]{64}$/u),
        id: expect.stringMatching(/^user_/u),
        name: "Ada Lovelace",
      },
      csrf: expect.any(String),
    });
    expect([...ada.cookies.keys()]).toEqual(["__Host-tabletop-session"]);
  });

  it("sets a session cookie scripts cannot read and other sites do not get", async () => {
    const ada = new Browser();
    const started = await ada.fetch("/auth/sign-in");
    const authorize = new URL(started.headers.get("Location")!);
    authorize.searchParams.set("fake_user", "Ada");
    const callback = new URL(
      (await fetch(authorize, { redirect: "manual" })).headers.get("Location")!,
    );

    const back = await ada.fetch(callback.pathname + callback.search);

    const session = back.headers
      .getSetCookie()
      .find((line) => line.startsWith("__Host-tabletop-session="));
    expect(session).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
  });

  it("refuses a callback whose state is not the one this browser started", async () => {
    const ada = new Browser();
    const started = await ada.fetch("/auth/sign-in");
    const authorize = new URL(started.headers.get("Location")!);
    authorize.searchParams.set("fake_user", "Ada");
    authorize.searchParams.set("state", "forged");
    const callback = new URL(
      (await fetch(authorize, { redirect: "manual" })).headers.get("Location")!,
    );

    const back = await ada.fetch(callback.pathname + callback.search);

    expect(back.headers.get("Location")).toBe("/boards?sign-in=failed");
    expect(await (await ada.fetch("/api/me")).json()).toEqual({ account: null, csrf: null });
  });

  it("refuses a callback in a browser that never started one", async () => {
    const mallory = new Browser();
    const back = await mallory.fetch("/auth/callback?code=stolen&state=whatever");

    expect(back.headers.get("Location")).toBe("/boards?sign-in=failed");
    expect(mallory.cookies.has("__Host-tabletop-session")).toBe(false);
  });

  it("sends a person back only to this origin", async () => {
    const ada = new Browser();
    const started = await ada.fetch("/auth/sign-in?return=//evil.test/");
    const authorize = new URL(started.headers.get("Location")!);
    authorize.searchParams.set("fake_user", "Ada");
    const callback = new URL(
      (await fetch(authorize, { redirect: "manual" })).headers.get("Location")!,
    );

    const back = await ada.fetch(callback.pathname + callback.search);

    expect(back.headers.get("Location")).toBe("/");
  });

  it("ends the session on sign-out, and the provider's with it", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");

    const out = await ada.post("/auth/sign-out");

    expect(await out.json()).toEqual({
      redirect: expect.stringMatching(
        /^https:\/\/workos\.test\/user_management\/sessions\/logout\?/u,
      ),
    });
    expect(await (await ada.fetch("/api/me")).json()).toEqual({ account: null, csrf: null });
  });
});

describe("an owner's boards", () => {
  it("lists the boards the account created and the ones it visited", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const bea = new Browser();
    await bea.signIn("Bea");
    const mine = await ada.createBoard("Ada's table");
    const hers = await bea.createBoard("Bea's table");

    await ada.bootstrap(hers.shareCode);

    expect(await ada.list()).toEqual({
      owned: [{ createdAt: expect.any(Number), ...mine }],
      visited: [
        {
          id: hers.id,
          shareCode: hers.shareCode,
          title: "Bea's table",
          visitedAt: expect.any(Number),
        },
      ],
    });
    expect((await bea.list()).visited).toEqual([]);
  });

  it("names the owner as owner and a visitor by their account", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const bea = new Browser();
    await bea.signIn("Bea");
    const board = await ada.createBoard();

    const own: Answer = await (await ada.bootstrap(board.shareCode)).json();
    const visit: Answer = await (await bea.bootstrap(board.shareCode)).json();

    expect(own.person).toEqual({
      id: expect.stringMatching(/^a:user_/u),
      name: "Ada",
      owner: true,
    });
    expect(visit.person).toEqual({
      id: expect.stringMatching(/^a:user_/u),
      name: "Bea",
      owner: false,
    });
  });

  it("cannot be made by someone signed out", async () => {
    const guest = new Browser();
    expect((await guest.post("/api/boards", { title: "Mine" })).status).toBe(401);
  });

  it("renames a board", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();

    const renamed = await ada.post(`/api/boards/${board.id}/rename`, { title: "  Mörk   Borg " });

    expect(await renamed.json()).toEqual({ ...board, title: "Mörk Borg" });
  });
});

describe("owner-only actions", () => {
  async function setUp() {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard("Keep");
    return { ada, board };
  }

  it.each(["rename", "reset", "delete"])(
    "%s is refused for another account, changing nothing",
    async (action) => {
      const { ada, board } = await setUp();
      const bea = new Browser();
      await bea.signIn("Bea");

      const response = await bea.post(`/api/boards/${board.id}/${action}`, { title: "Taken" });

      expect(response.status).toBe(404);
      expect((await ada.list()).owned).toEqual([{ createdAt: expect.any(Number), ...board }]);
    },
  );

  it.each(["rename", "reset", "delete"])("%s is refused for a guest", async (action) => {
    const { board } = await setUp();
    const guest = new Browser();
    await guest.bootstrap(board.shareCode, { name: "Guest" });

    expect((await guest.post(`/api/boards/${board.id}/${action}`, { title: "x" })).status).toBe(
      401,
    );
  });

  it("is refused without the session's CSRF token", async () => {
    const { ada, board } = await setUp();

    const response = await ada.post(
      `/api/boards/${board.id}/delete`,
      {},
      { "X-CSRF-Token": "guess" },
    );

    expect(response.status).toBe(403);
    expect((await ada.list()).owned).toHaveLength(1);
  });

  it("is refused from another origin, token or not", async () => {
    const { ada, board } = await setUp();

    const response = await ada.post(
      `/api/boards/${board.id}/delete`,
      {},
      { Origin: "https://evil.test" },
    );

    expect(response.status).toBe(403);
    expect((await ada.list()).owned).toHaveLength(1);
  });
});

describe("a guest", () => {
  it("joins by link with a name, then draws and rolls on the board", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const guest = new Browser();

    expect(await (await guest.bootstrap(board.shareCode)).json()).toEqual({
      error: "name-required",
    });
    expect(await (await guest.bootstrap(board.shareCode, { name: "\u0007" })).json()).toEqual({
      error: "name-invalid",
    });
    const joined: Answer = await (await guest.bootstrap(board.shareCode, { name: " Cy " })).json();

    expect(joined.person).toEqual({ id: expect.stringMatching(/^g:/u), name: "Cy", owner: false });
    expect((await openSocket(joined.board, joined.pass)).response.status).toBe(101);
    const rolled = await roomCall(`/rooms/${joined.board}/roll`, joined.pass, {
      body: JSON.stringify({ dice: [6, 6] }),
      method: "POST",
    });
    expect(rolled.status).toBe(200);
  });

  it("keeps their name and id for the next visit", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const guest = new Browser();
    const first: Answer = await (await guest.bootstrap(board.shareCode, { name: "Cy" })).json();

    const again: Answer = await (await guest.bootstrap(board.shareCode)).json();

    expect(again.person).toEqual(first.person);
  });

  it("is refused by a link that names no board", async () => {
    const guest = new Browser();
    expect((await guest.bootstrap("NoSuchBoardHere", { name: "Cy" })).status).toBe(404);
  });

  it("asks for passes no faster than the limit allows", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const guest = new Browser();
    const statuses = [];
    for (let attempt = 0; attempt < 31; attempt++) {
      statuses.push((await guest.bootstrap(board.shareCode, { name: "Cy" })).status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("resetting a board's link", () => {
  it("gives the board a new link, closes the old one, and puts its guests out", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const bea = new Browser();
    await bea.signIn("Bea");
    const board = await ada.createBoard();
    const guest = new Browser();
    const joined: Answer = await (await guest.bootstrap(board.shareCode, { name: "Cy" })).json();
    await bea.bootstrap(board.shareCode);
    const seated = await openSocket(joined.board, joined.pass);

    const reset: { shareCode: string } = await (
      await ada.post(`/api/boards/${board.id}/reset`)
    ).json();

    expect(reset.shareCode).not.toBe(board.shareCode);
    expect(await seated.closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.FORBIDDEN,
    });
    expect((await guest.bootstrap(board.shareCode)).status).toBe(404);
    expect((await guest.bootstrap(reset.shareCode)).status).toBe(200);
    expect((await bea.list()).visited).toEqual([
      { id: board.id, shareCode: null, title: board.title, visitedAt: expect.any(Number) },
    ]);
  });
});

describe("deleting a board", () => {
  it("forgets it, wipes its room and puts everyone out", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const own: Answer = await (await ada.bootstrap(board.shareCode)).json();
    await roomCall(`/rooms/${own.board}/roll`, own.pass, {
      body: JSON.stringify({ dice: [20] }),
      method: "POST",
    });
    const seated = await openSocket(own.board, own.pass);

    expect((await ada.post(`/api/boards/${board.id}/delete`)).status).toBe(204);

    expect(await seated.closure).toEqual({
      code: TLSyncErrorCloseEventCode,
      reason: TLSyncErrorCloseEventReason.NOT_FOUND,
    });
    expect((await ada.list()).owned).toEqual([]);
    expect((await ada.bootstrap(board.shareCode)).status).toBe(404);
  });
});

describe("the two modes' passes", () => {
  it("a host's pass opens nothing on a standalone tabletop", async () => {
    const response = await roomCall("/rooms/b1/rolls", await hostedPass());
    expect(response.status).toBe(403);
  });

  it("a host's pass opens nothing even when the standalone key is the host's", async () => {
    const sharedKey = {
      ...standaloneEnv,
      SIGNING_KEY: (env as unknown as { TEST_SIGNING_KEY: string }).TEST_SIGNING_KEY,
    };
    const response = await roomCall("/rooms/b1/rolls", await hostedPass(), {}, sharedKey);
    expect(response.status).toBe(403);
  });

  it("a standalone pass opens nothing on a hosted tabletop, even one trusting the same key", async () => {
    const ada = new Browser();
    await ada.signIn("Ada");
    const board = await ada.createBoard();
    const own: Answer = await (await ada.bootstrap(board.shareCode)).json();
    const sameKey = {
      ...hostedEnv,
      ISSUER_PUBLIC_KEY: createPublicKey(standaloneEnv.SIGNING_KEY!)
        .export({ format: "pem", type: "spki" })
        .toString(),
    };

    expect((await roomCall(`/rooms/${own.board}/rolls`, own.pass)).status).toBe(200);
    expect((await roomCall(`/rooms/${own.board}/rolls`, own.pass, {}, sameKey)).status).toBe(403);
  });

  it("a hosted Worker cannot be configured to accept the standalone issuer's passes", async () => {
    const forged = await new SignJWT({ board: "b1", link: 0, name: "X", owner: true })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("tabletop")
      .setAudience("tabletop-standalone")
      .setSubject("g:1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await importPKCS8(standaloneEnv.SIGNING_KEY!, "RS256"));
    const configured = { ...hostedEnv, ISSUER: "tabletop", PASS_AUDIENCE: "tabletop-standalone" };

    expect((await roomCall("/rooms/b1/rolls", forged, {}, configured)).status).toBe(500);
  });

  it.each([
    ["a host's key", { ISSUER_PUBLIC_KEY: "anything" }],
    ["a host's origin", { HOST_ORIGIN: "https://host.test" }],
    ["no WorkOS client", { WORKOS_CLIENT_ID: undefined }],
    ["no WorkOS key", { WORKOS_API_KEY: undefined }],
  ])("a standalone configuration with %s serves nothing", async (_label, overrides) => {
    const guest = new Browser();
    const response = await guest.fetch("/", {}, { ...standaloneEnv, ...overrides });
    expect(response.status).toBe(500);
  });
});
