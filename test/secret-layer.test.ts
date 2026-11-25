import { describe, expect, it } from "vitest";

import { fileKey, textKey } from "../src/file-store";
import { FILE_COOKIE } from "../src/files";
import { handle } from "../src/index";
import { secretLayerOf } from "../src/secret-layer";
import { Browser, openSocket, ORIGIN, roomCall, standaloneEnv } from "./standalone-support";

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
});
