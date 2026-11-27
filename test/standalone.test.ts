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
import { getIndexAbove, sortByIndex, ZERO_INDEX_KEY } from "@tldraw/utils";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";
import { createPublicKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/index";

import { avatarKey } from "../src/avatars";
import { type ChatMessage, MAX_CHAT_LENGTH, MAX_CHAT_MESSAGES_PER_MINUTE } from "../src/chat";
import { fileKey, textKey } from "../src/file-store";
import { saveArrowEndpoints } from "../src/public-arrow-endpoints";
import { PUBLIC_SWEEP_MS, stampPublicShape } from "../src/public-board-expiry";
import { PUBLIC_SIGNATURE_GROUP } from "../src/public-signature";
import { secretLayerOf } from "../src/secret-layer";
import { Browser, openSocket, ORIGIN, roomCall, standaloneEnv } from "./standalone-support";
import { pass as hostedPass, seat, until } from "./support";

type Answer = { board: string; pass: string; person: { id: string; name: string; owner: boolean } };

const hostedEnv = env as unknown as Env;
const drawing = (state: DurableObjectState) =>
  new SQLiteSyncStorage<TLRecord>({
    sql: new DurableObjectSqliteSyncWrapper(state.storage, { tablePrefix: "tldraw_" }),
  });

describe("the public board", () => {
  it("assigns public-board ownership only to the configured WorkOS account", async () => {
    const owner = new Browser();
    const guest = new Browser();
    const other = new Browser();
    await owner.signIn("Same name");
    await other.signIn("Same name");
    const { account } = await (await owner.fetch("/api/me")).json<{ account: { id: string } }>();
    const workerEnv = { ...standaloneEnv, PUBLIC_BOARD_OWNER_ID: account.id };
    const bootstrap = (browser: Browser, environment: typeof standaloneEnv = workerEnv) =>
      browser.fetch(
        "/api/public-board/bootstrap",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN },
          body: "{}",
        },
        environment,
      );
    const assigned = await (await bootstrap(owner)).json<Answer>();
    expect(assigned.person).toMatchObject({ id: `a:${account.id}`, owner: true });
    expect(assigned).not.toHaveProperty("secretPass");
    for (const browser of [guest, other]) {
      expect((await (await bootstrap(browser)).json<Answer>()).person.owner).toBe(false);
    }
    expect((await (await bootstrap(owner, standaloneEnv)).json<Answer>()).person.owner).toBe(false);
  });

  it("keeps a guest's generated name and lets guests and members share chat", async () => {
    const guest = new Browser();
    const member = new Browser();
    await member.signIn("Ada Lovelace");

    const bootstrap = "/api/public-board/bootstrap";
    const initial = await guest.post(bootstrap);
    expect(initial.status).toBe(200);
    const anonymous = (await initial.json()) as Answer;
    expect(anonymous.person).toMatchObject({
      id: expect.stringMatching(/^g:/u),
      name: expect.stringMatching(/^\S+\s+\S/u),
      owner: false,
    });
    expect(anonymous.person.name).not.toMatch(/^Guest\s/u);
    const refreshed = (await (await guest.post(bootstrap)).json()) as Answer;
    expect(refreshed.person).toEqual(anonymous.person);
    const signedIn = (await (await member.post(bootstrap)).json()) as Answer;
    const chat = `/rooms/${anonymous.board}/chat`;

    const sent = await guest.fetch(chat, {
      body: "  Has anyone seen my map?  ",
      headers: { Authorization: `Bearer ${anonymous.pass}` },
      method: "POST",
    });
    expect(sent.status).toBe(200);
    const first: ChatMessage = await sent.json();
    expect(first).toMatchObject({
      name: anonymous.person.name,
      sub: anonymous.person.id,
      text: "Has anyone seen my map?",
    });
    const reply = await member.fetch(chat, {
      body: "It is by the dice.",
      headers: { Authorization: `Bearer ${signedIn.pass}` },
      method: "POST",
    });
    expect(reply.status).toBe(200);
    const second: ChatMessage = await reply.json();
    expect(second).toMatchObject({ name: "Ada Lovelace", text: "It is by the dice." });
    expect(second.id).toBeGreaterThan(first.id);

    for (const pass of [refreshed.pass, signedIn.pass]) {
      const history = await roomCall(chat, pass);
      expect(history.status).toBe(200);
      const messages: ChatMessage[] = await history.json();
      expect(messages.slice(-2)).toEqual([first, second]);
    }
  });

  it("restricts chat to the pass's own board, outside the secret layer, and bounded text", async () => {
    const guest = new Browser();
    const { board, pass } = (await (
      await guest.post("/api/public-board/bootstrap")
    ).json()) as Answer;
    const chat = `/rooms/${board}/chat`;
    expect((await guest.fetch(chat)).status).toBe(403);
    expect((await guest.fetch(chat, { body: "Hello", method: "POST" })).status).toBe(403);

    const member = new Browser();
    await member.signIn("Ania");
    const { shareCode } = await member.createBoard();
    const own = (await (await member.bootstrap(shareCode)).json()) as Answer & {
      secretPass: string;
    };
    expect((await roomCall(chat, own.pass)).status).toBe(403);
    expect(await (await roomCall(`/rooms/${own.board}/chat`, own.pass)).json()).toEqual([]);
    const secretChat = `/rooms/${secretLayerOf(own.board)}/chat`;
    expect((await roomCall(secretChat, own.secretPass)).status).toBe(404);

    for (const [body, status] of [
      ["   ", 400],
      ["x".repeat(MAX_CHAT_LENGTH + 1), 400],
      ["x".repeat(MAX_CHAT_LENGTH * 5), 413],
    ] as const) {
      const invalid = await guest.fetch(chat, {
        body,
        headers: { Authorization: `Bearer ${pass}` },
        method: "POST",
      });
      expect(invalid.status).toBe(status);
    }
  });

  it("keeps overlapping siblings in paint order when a moved, older group expires", async () => {
    const board = "public-paint-order";
    const namespace = hostedEnv.BoardRoom;
    const id = namespace.idFromName(board);
    const initial = namespace.get(id);
    await initial.schedulePublicExpiry();
    const page = PageRecordType.createId("page");
    const stacked = getIndexAbove(getIndexAbove(ZERO_INDEX_KEY));
    const group = (name: string, parentId: TLGroupShape["parentId"] = page): TLGroupShape => ({
      id: createShapeId(name),
      index: stacked,
      isLocked: false,
      meta: {},
      opacity: 1,
      parentId,
      props: {},
      rotation: 0,
      type: "group",
      typeName: "shape",
      x: 0,
      y: 0,
    });
    const old = stampPublicShape(group("lower-expiring"), Date.now() - 8 * PUBLIC_SWEEP_MS - 1);
    const upper = stampPublicShape(group("upper-surviving"), Date.now());
    const child = stampPublicShape(group("child-surviving", old.id), Date.now());
    await runInDurableObject(initial, (_room, state) => {
      drawing(state).transaction((store) => {
        for (const record of [old, upper, child]) store.set(record.id, record);
      });
      state.storage.kv.delete("publicOrderNormalized");
    });
    await expect(
      runInDurableObject(initial, (_room, state) => state.abort("reload legacy drawing")),
    ).rejects.toThrow("reload legacy drawing");

    const room = namespace.get(id);
    const writer = await seat(board, await hostedPass({ board }));
    const newSibling = group("new-sibling");
    writer.send({
      clientClock: 1,
      diff: { [newSibling.id]: ["put", newSibling], [old.id]: ["patch", { x: ["put", 20] }] },
      type: "push",
    });
    await until(() =>
      writer.received.some(({ data }) => JSON.stringify(data)?.includes('"push_result"')),
    );

    const indices = await runInDurableObject(
      room,
      (_room, state) =>
        drawing(state).transaction((store) =>
          [old, upper, newSibling].map((record) => (store.get(record.id) as TLGroupShape).index),
        ).result,
    );
    expect(new Set(indices).size).toBe(3);
    expect(indices[0]).toBe(stacked);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    await runInDurableObject(room, (_room, state) => {
      drawing(state).transaction((store) => {
        expect(store.get(old.id)).toBeUndefined();
        const after = [child, upper, newSibling].map(
          (record) => store.get(record.id) as TLGroupShape,
        );
        expect(after[0]).toMatchObject({ parentId: page, x: 20 });
        expect(after.sort(sortByIndex).map(({ id }) => id)).toEqual([
          child.id,
          newSibling.id,
          upper.id,
        ]);
      });
    });
  });

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
    await runInDurableObject(room, (_room, state) => {
      drawing(state).transaction((store) => {
        const signature = store.get(PUBLIC_SIGNATURE_GROUP);
        expect(signature).toMatchObject({ isLocked: true, parentId: page, type: "group" });
        store.set(signature!.id, stampPublicShape(signature as TLGroupShape, now - 2 * day - 1));
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
        expect(store.get(PUBLIC_SIGNATURE_GROUP)).toMatchObject({ opacity: 1 });
        expect(
          [...store.values()].filter(
            (record) => record.typeName === "shape" && record.parentId === PUBLIC_SIGNATURE_GROUP,
          ),
        ).toHaveLength(4);
        expect(store.get(faded.id)).toMatchObject({ meta: faded.meta, opacity: 0.5 });
        expect(store.get(faint.id)).toEqual(faint);
        expect(store.get(recent.id)).toMatchObject({
          meta: recent.meta,
          opacity: 1,
          parentId: page,
          x: 102,
          y: 33,
        });
        expect(store.get(page)).toMatchObject({ name: "Landing Page" });
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

it("isolates board lists, links, and mutations between previews sharing D1", async () => {
  const person = new Browser();
  await person.signIn("Ada");
  const first = { ...standaloneEnv, BOARD_DATA_SCOPE: "pr-71" };
  const second = { ...standaloneEnv, BOARD_DATA_SCOPE: "pr-72" };
  const post = (path: string, worker: Env, body = {}) =>
    person.fetch(
      path,
      {
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "X-CSRF-Token": person.csrf!,
        },
        method: "POST",
      },
      worker,
    );
  const made = await post("/api/boards", first, { title: "Preview map" });
  expect(made.status).toBe(201);
  const board: { id: string; shareCode: string } = await made.json();
  const bootstrap = `/api/b/${board.shareCode}/bootstrap`;

  expect((await post(bootstrap, second)).status).toBe(404);
  expect((await post(`/api/boards/${board.id}/delete`, second)).status).toBe(404);
  expect(await (await person.fetch("/api/boards", {}, second)).json()).toMatchObject({
    owned: [],
    visited: [],
  });
  expect((await post(bootstrap, first)).status).toBe(200);
  expect(await (await person.fetch("/api/boards", {}, first)).json()).toMatchObject({
    owned: [{ id: board.id }],
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

  it("copies an unchanged avatar again when the current bucket lacks it", async () => {
    const person = new Browser();
    await person.signIn("Ada");
    const { account }: { account: { avatar: string } } = await (
      await person.fetch("/api/me")
    ).json();
    const hash = account.avatar.split("/").at(-1)!;

    await standaloneEnv.Files.delete(avatarKey(hash));
    expect((await person.fetch(account.avatar)).status).toBe(404);
    await person.signIn("Ada");
    expect((await person.fetch(account.avatar)).status).toBe(200);
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
      account: { avatar: expect.any(String), id: expect.any(String), name: "Ada" },
      csrf: ada.csrf,
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
      role: "owner",
    });
    expect(visit.person).toEqual({
      id: expect.stringMatching(/^a:user_/u),
      name: "Bea",
      owner: false,
      role: "write",
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

    expect(joined.person).toEqual({
      id: expect.stringMatching(/^g:/u),
      name: "Cy",
      owner: false,
      role: "write",
    });
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
    const windowMs = 60_000;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        expect((await guest.bootstrap(board.shareCode, { name: "Cy" })).status).toBe(200);
      }
      expect((await guest.bootstrap(board.shareCode, { name: "Cy" })).status).toBe(429);

      clock.mockReturnValue(now + windowMs);
      expect((await guest.bootstrap(board.shareCode, { name: "Cy" })).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
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

it("shares the posting allowance between chat rolls and text", async () => {
  const guest = new Browser();
  const { board, pass } = await (await guest.post("/api/public-board/bootstrap")).json<Answer>();
  const chat = "/rooms/" + board + "/chat";
  const send = (body: string) =>
    guest.fetch(chat, {
      body,
      headers: { Authorization: "Bearer " + pass },
      method: "POST",
    });
  const first = await send("/roll 1d1");
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ diceTotal: 1, text: "1d1" });
  for (let index = 1; index < MAX_CHAT_MESSAGES_PER_MINUTE; index++) {
    expect((await send("Message " + index)).status).toBe(200);
  }
  const before = await (await roomCall(chat, pass)).json<ChatMessage[]>();
  expect((await send("/r 2d1")).status).toBe(429);
  const history = await (await roomCall(chat, pass)).json<ChatMessage[]>();
  expect(history).toEqual(before);
  expect(history.at(-MAX_CHAT_MESSAGES_PER_MINUTE)).toMatchObject({ diceTotal: 1, text: "1d1" });
});
