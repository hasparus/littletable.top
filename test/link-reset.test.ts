import { describe, expect, it } from "vitest";

import {
  call,
  deletion,
  destroy,
  linkReset,
  now,
  open,
  pass,
  restartRoom,
  seat,
  until,
} from "./support";

const reset = (board: string, token: string | null) =>
  call(`/rooms/${board}/link`, token, { method: "POST" });

describe("resetting a hosted link", () => {
  it("disconnects users on the old version before anyone opens the new link", async () => {
    const board = "reset-now";
    const oldPass = await pass({ board, sub: "g:guest" });
    const guest = await seat(board, oldPass);

    expect((await reset(board, await linkReset({ board, link: 2 }))).status).toBe(204);
    await until(guest.isClosed);
    expect(await guest.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
    expect(await call(`/rooms/${board}/rolls`, oldPass).then((client) => client.text())).toBe(
      "link-reset",
    );
    expect((await call(`/rooms/${board}/rolls`, await pass({ board, link: 2 }))).status).toBe(200);
  });

  it("rejects the old pass when it reconnects first after a room restart", async () => {
    const board = "reset-restart";
    const oldPass = await pass({ board, link: 0, sub: "g:guest" });
    const currentPass = await pass({ board, link: 2, sub: "g:guest" });
    expect((await reset(board, await linkReset({ board, link: 2 }))).status).toBe(204);
    await restartRoom(board);

    const rejected = await open(board, oldPass);
    expect(rejected.response.status).toBe(101);
    await expect(rejected.closure).resolves.toEqual({ code: 4099, reason: "FORBIDDEN" });
    const guest = await seat(board, currentPass);
    guest.close();
  });

  it("ignores a retry and an older version", async () => {
    const board = "reset-order";
    expect((await reset(board, await linkReset({ board, link: 3 }))).status).toBe(204);
    const current = await seat(board, await pass({ board, link: 3 }));

    expect((await reset(board, await linkReset({ board, link: 3 }))).status).toBe(204);
    expect((await reset(board, await linkReset({ board, link: 2 }))).status).toBe(204);
    expect(current.isClosed()).toBe(false);
    expect((await call(`/rooms/${board}/rolls`, await pass({ board, link: 2 }))).status).toBe(403);
  });

  const board = "reset-denied";
  it.each([
    ["a pass", () => pass({ board, link: 2 })],
    ["a deletion token", () => deletion({ board })],
    ["a reset for another board", () => linkReset({ board: "another", link: 2 })],
    ["an expired reset", () => linkReset({ board, link: 2 }, now() - 3_600)],
    ["no token", async () => null],
  ])("refuses %s and leaves the version alone", async (_label, token) => {
    expect((await reset(board, await token())).status).toBe(403);
    expect((await call(`/rooms/${board}/rolls`, await pass({ board }))).status).toBe(200);
  });

  it.each([undefined, "2", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the link claim %s",
    async (link) => {
      expect((await reset(board, await linkReset({ board, link }))).status).toBe(403);
    },
  );

  it("gives a reset token no other board permission", async () => {
    const token = await linkReset({ board, link: 2 });

    expect((await open(board, token)).response.status).toBe(403);
    expect((await destroy(board, token)).status).toBe(403);
  });
});
