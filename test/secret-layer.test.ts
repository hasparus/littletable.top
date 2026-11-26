import { createTLSchema } from "@tldraw/tlschema";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import { fileKey, textKey } from "../src/file-store";
import { FILE_COOKIE } from "../src/files";
import { handle } from "../src/index";
import { secretLayerOf } from "../src/secret-layer";
import { Browser, openSocket, ORIGIN, roomCall, standaloneEnv } from "./standalone-support";
import { TLSYNC_PROTOCOL_VERSION, until } from "./support";

type Bootstrap = { board: string; pass: string; secretPass?: string };

async function accountBoard() {
  const owner = new Browser();
  await owner.signIn("Game master");
  const board = await owner.createBoard();
  const passes = (await (await owner.bootstrap(board.shareCode)).json()) as Bootstrap;
  expect(passes.secretPass).toEqual(expect.any(String));
  const secret = secretLayerOf(board.id);
  return {
    board,
    owner,
    secret,
    secretFiles: `/rooms/${secret}/files`,
    secretPass: passes.secretPass!,
    sharedPass: passes.pass,
  };
}

async function readSecretLayer(board: string, pass: string) {
  const open = await openSocket(board, pass);
  expect(open.response.status).toBe(101);
  const received: string[] = [];
  open.socket!.addEventListener("message", ({ data }) => {
    received.push(String(data));
  });
  open.socket!.send(
    JSON.stringify({
      connectRequestId: crypto.randomUUID(),
      lastServerClock: 0,
      protocolVersion: TLSYNC_PROTOCOL_VERSION,
      schema: createTLSchema().serialize(),
      type: "connect",
    }),
  );
  await until(() => received.some((message) => message.includes('"type":"connect"')));
  return {
    ...open,
    received,
    send: (message: object) => open.socket!.send(JSON.stringify(message)),
  };
}

async function rollSecretLayer(board: string, token: string) {
  const response = await roomCall(`/rooms/${board}/roll`, token, {
    body: JSON.stringify({ dice: [6] }),
    method: "POST",
  });
  expect(response.status).toBe(200);
}

const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

describe("the secret layer", () => {
  it("accepts a pass scoped to the secret layer and refuses all shared passes", async () => {
    const { board, owner, secret, secretFiles, secretPass, sharedPass } = await accountBoard();
    const guest = new Browser();
    const visitor = new Browser();
    await visitor.signIn("Account visitor");
    const guestPass = (await (
      await guest.bootstrap(board.shareCode, { name: "Guest" })
    ).json()) as Bootstrap;
    const visitorPass = (await (await visitor.bootstrap(board.shareCode)).json()) as Bootstrap;
    const lobby = (await (await owner.post("/api/public-board/bootstrap")).json()) as Bootstrap;
    expect(guestPass).not.toHaveProperty("secretPass");
    expect(visitorPass).not.toHaveProperty("secretPass");
    expect(lobby).not.toHaveProperty("secretPass");

    expect((await openSocket(secret, secretPass)).response.status).toBe(101);
    expect((await openSocket(board.id, secretPass)).response.status).toBe(403);
    expect((await openSocket(secretLayerOf(lobby.board), lobby.pass)).response.status).toBe(404);

    const uploaded = await roomCall(secretFiles, secretPass, { body: picture, method: "POST" });
    expect(uploaded.status).toBe(201);
    const { hash, src } = (await uploaded.json()) as { hash: string; src: string };
    expect(src).toBe(`${secretFiles}/${hash}`);
    const text = `${src}/text/tesseract-6.0.1`;
    await standaloneEnv.Files.put(textKey(secret, hash, "tesseract-6.0.1"), "private reading");
    const read = await roomCall(src, secretPass);
    expect(read.headers.get("Cache-Control")).toBe("no-store");
    expect(await read.text()).toBe(picture);
    expect(await (await roomCall(text, secretPass)).text()).toBe("private reading");

    const access = await roomCall(`${secretFiles}/access`, secretPass, { method: "POST" });
    expect(access.status).toBe(200);
    expect(access.headers.get("Set-Cookie")).toContain(`Path=${secretFiles};`);
    const cookieRead = (token: string) =>
      handle(
        new Request(`${ORIGIN}${src}`, { headers: { Cookie: `${FILE_COOKIE}=${token}` } }),
        standaloneEnv,
      );
    expect(await (await cookieRead(secretPass)).text()).toBe(picture);
    for (const pass of [sharedPass, guestPass.pass, visitorPass.pass]) {
      expect((await openSocket(secret, pass)).response.status).toBe(403);
      expect((await cookieRead(pass)).status).toBe(403);
      expect((await roomCall(src, pass, { method: "HEAD" })).status).toBe(403);
      expect((await roomCall(text, pass)).status).toBe(403);
      expect((await roomCall(`${secretFiles}/text`, pass)).status).toBe(403);
      expect((await roomCall(`${secretFiles}/access`, pass, { method: "POST" })).status).toBe(403);
      expect((await roomCall(secretFiles, pass, { body: picture, method: "POST" })).status).toBe(
        403,
      );
      expect((await roomCall(`/rooms/${board.id}/files/${hash}`, pass)).status).toBe(404);
    }
  });

  it("keeps the layer after a link reset and removes it with the board", async () => {
    const { board, owner, secret, secretFiles, secretPass } = await accountBoard();
    const old = await openSocket(secret, secretPass);
    expect(old.response.status).toBe(101);
    const uploaded = await roomCall(secretFiles, secretPass, { body: picture, method: "POST" });
    const { hash, src } = (await uploaded.json()) as { hash: string; src: string };
    const reset = await owner.post(`/api/boards/${board.id}/reset`);
    expect(reset.status).toBe(200);
    expect(await old.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
    expect((await roomCall(src, secretPass)).status).toBe(403);
    const { shareCode } = (await reset.json()) as { shareCode: string };
    const fresh = (await (await owner.bootstrap(shareCode)).json()) as Bootstrap;
    expect(await (await roomCall(src, fresh.secretPass!)).text()).toBe(picture);

    const open = await openSocket(secret, fresh.secretPass!);
    expect(open.response.status).toBe(101);
    expect((await owner.post(`/api/boards/${board.id}/delete`)).status).toBe(204);
    expect(await open.closure).toEqual({ code: 4099, reason: "NOT_FOUND" });
    expect(await standaloneEnv.Files.head(fileKey(secret, hash))).toBeNull();
    expect(
      (await roomCall(secretFiles, fresh.secretPass!, { body: picture, method: "POST" })).status,
    ).toBe(403);
    expect(await (await openSocket(secret, fresh.secretPass!)).closure).toEqual({
      code: 4099,
      reason: "NOT_FOUND",
    });
  });

  it("closes secret sockets and invalidates their passes when the owner signs out", async () => {
    const { owner, board, secret, secretPass } = await accountBoard();
    const open = await openSocket(secret, secretPass);
    expect(open.response.status).toBe(101);

    await owner.signIn("Game master");
    const second = (await (await owner.bootstrap(board.shareCode)).json()) as Bootstrap;
    const current = await openSocket(secret, second.secretPass!);
    expect(current.response.status).toBe(101);

    expect((await owner.post("/auth/sign-out")).status).toBe(200);
    expect(await current.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
    expect((await openSocket(secret, second.secretPass!)).response.status).toBe(403);
    expect((await roomCall(`/rooms/${secret}/rolls`, second.secretPass!)).status).toBe(403);
    expect((await roomCall(`/rooms/${secret}/rolls`, secretPass)).status).toBe(200);
    open.socket?.close();
  });

  it("disconnects a receive-only reader of an expired account session", async () => {
    const { owner, board, secret, secretPass } = await accountBoard();
    const hash = String(decodeJwt(secretPass).sessionHash);
    const expiry = Math.floor(Date.now() / 1000) + 2;
    await standaloneEnv
      .DB!.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
      .bind(expiry, hash)
      .run();
    const { BoardRoom } = standaloneEnv;
    const room = BoardRoom.get(BoardRoom.idFromName(secret));

    const reader = await readSecretLayer(secret, secretPass);
    expect(await runInDurableObject(room, (_room, { storage }) => storage.getAlarm())).toBe(
      expiry * 1000,
    );

    await owner.signIn("Game master");
    const current = (await (await owner.bootstrap(board.shareCode)).json()) as Bootstrap;
    const peer = await readSecretLayer(secret, current.secretPass!);
    await expect.poll(() => Date.now(), { timeout: 4000 }).toBeGreaterThanOrEqual(expiry * 1000);

    await rollSecretLayer(secret, current.secretPass!);
    await until(() => peer.received.some((message) => message.includes('"type":"roll"')));
    expect(await reader.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
    expect(reader.received.some((message) => message.includes('"type":"roll"'))).toBe(false);
    peer.socket?.close();
  });

  it("rechecks private readers after hibernation and recovers from failed sign-out fanout", async () => {
    const { owner, board, secret, secretPass } = await accountBoard();
    const retained = await readSecretLayer(secret, secretPass);
    await owner.signIn("Game master");
    const current = (await (await owner.bootstrap(board.shareCode)).json()) as Bootstrap;
    const revoked = await readSecretLayer(secret, current.secretPass!);
    const { BoardRoom } = standaloneEnv;
    const room = BoardRoom.get(BoardRoom.idFromName(secret));

    await evictDurableObject(room, { webSockets: "hibernate" });
    const page = {
      id: "page:private-after-hibernation",
      index: "a2",
      meta: {},
      name: "After hibernation",
      typeName: "page",
    };
    retained.send({ clientClock: 1, diff: { [page.id]: ["put", page] }, type: "push" });
    await until(() => revoked.received.some((message) => message.includes(page.id)));

    let deliveryAttempts = 0;
    const unavailableRooms = {
      get() {
        return {
          disconnectSession() {
            deliveryAttempts++;
            return Promise.reject(new Error("Unavailable room"));
          },
        };
      },
      idFromName: (name: string) => BoardRoom.idFromName(name),
    } as unknown as typeof BoardRoom;
    const signedOut = await owner.fetch(
      "/auth/sign-out",
      {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "X-CSRF-Token": owner.csrf!,
        },
        method: "POST",
      },
      { ...standaloneEnv, BoardRoom: unavailableRooms },
    );
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(deliveryAttempts).toBe(1);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await revoked.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
    expect((await openSocket(secret, current.secretPass!)).response.status).toBe(403);

    await rollSecretLayer(secret, secretPass);
    await until(() => retained.received.some((message) => message.includes('"type":"roll"')));
    expect(revoked.received.some((message) => message.includes('"type":"roll"'))).toBe(false);
    retained.socket?.close();
  });
});
