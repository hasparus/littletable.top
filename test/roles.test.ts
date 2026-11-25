import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { BoardGrant, RoomDocumentCalls } from "../src/room-contract";

import { Browser } from "./standalone-support";
import { open, pass } from "./support";

// Roles on a board: anyone with a pass draws; a manager may also connect an
// assistant; the owner makes managers. A standalone tabletop keeps the roles
// itself; a host names them in its passes.

type Answer = { person: { id: string; owner: boolean; role: string } };
type Listed = { people: { avatar: string | null; id: string; name: string; role: string }[] };

const rooms = (env as unknown as { BoardRoom: DurableObjectNamespace }).BoardRoom;
const roomOf = (board: string) =>
  rooms.get(rooms.idFromName(board)) as unknown as RoomDocumentCalls;

async function table() {
  const ada = new Browser();
  await ada.signIn("Ada");
  const bea = new Browser();
  await bea.signIn("Bea");
  const board = await ada.createBoard();
  const joined: Answer = await (await bea.bootstrap(board.shareCode)).json();
  return { ada, bea, beaId: joined.person.id.replace(/^a:/u, ""), board };
}

const roleUrl = (board: string, person: string) => `/api/boards/${board}/people/${person}/role`;

describe("the owner's permissions page (standalone)", () => {
  it("lists the accounts that joined, and makes one a manager for its next pass", async () => {
    const { ada, bea, beaId, board } = await table();
    const guest = new Browser();
    await guest.bootstrap(board.shareCode, { name: "Cy" });

    const before: Listed = await (await ada.fetch(`/api/boards/${board.id}/people`)).json();
    expect(before.people).toEqual([
      {
        avatar: expect.stringMatching(/^\/api\/avatars\//u),
        id: beaId,
        name: "Bea",
        role: "write",
      },
    ]);

    const set = await ada.post(roleUrl(board.id, beaId), { role: "manager" });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: beaId, role: "manager" });
    const again: Answer = await (await bea.bootstrap(board.shareCode)).json();
    expect(again.person).toMatchObject({ owner: false, role: "manager" });
    const own: Answer = await (await ada.bootstrap(board.shareCode)).json();
    expect(own.person).toMatchObject({ owner: true, role: "owner" });
  });

  it("is the owner's alone: nobody else reads the list or sets a role", async () => {
    const { ada, bea, beaId, board } = await table();
    const out = new Browser();

    expect((await out.fetch(`/api/boards/${board.id}/people`)).status).toBe(401);
    expect((await bea.fetch(`/api/boards/${board.id}/people`)).status).toBe(404);
    expect((await out.post(roleUrl(board.id, beaId), { role: "manager" })).status).toBe(401);
    expect((await bea.post(roleUrl(board.id, beaId), { role: "manager" })).status).toBe(404);
    const noToken = await ada.post(
      roleUrl(board.id, beaId),
      { role: "manager" },
      { "X-CSRF-Token": "guess" },
    );
    expect(noToken.status).toBe(403);
    const elsewhere = await ada.post(
      roleUrl(board.id, beaId),
      { role: "manager" },
      { Origin: "https://evil.test" },
    );
    expect(elsewhere.status).toBe(403);

    const after: Listed = await (await ada.fetch(`/api/boards/${board.id}/people`)).json();
    expect(after.people.map((person) => person.role)).toEqual(["write"]);
  });

  it("refuses a role that is not one, an account that never joined, and a guest", async () => {
    const { ada, beaId, board } = await table();
    const guest = new Browser();
    const joined: Answer = await (await guest.bootstrap(board.shareCode, { name: "Cy" })).json();

    expect((await ada.post(roleUrl(board.id, beaId), { role: "owner" })).status).toBe(400);
    expect((await ada.post(roleUrl(board.id, beaId), {})).status).toBe(400);
    expect((await ada.post(roleUrl(board.id, "user_nobody"), { role: "manager" })).status).toBe(404);
    // A guest has no account: its id names nobody the owner could promote.
    const guestId = joined.person.id.replace(/^g:/u, "");
    expect((await ada.post(roleUrl(board.id, guestId), { role: "manager" })).status).toBe(404);
    expect(joined.person).toMatchObject({ role: "write" });
  });

  it("ends the board's assistants when a manager is made an ordinary member again", async () => {
    const { ada, beaId, board } = await table();
    const grant: BoardGrant = {
      access: "read",
      board: board.id,
      grant: 0,
      role: "manager",
      title: null,
    };
    await ada.post(roleUrl(board.id, beaId), { role: "manager" });
    expect(await roomOf(board.id).readDocument(grant, { scope: "document" })).toMatchObject({
      clock: 0,
    });

    await ada.post(roleUrl(board.id, beaId), { role: "write" });

    expect(await roomOf(board.id).readDocument(grant, { scope: "document" })).toBe("revoked");
    expect(
      await roomOf(board.id).readDocument({ ...grant, grant: 1 }, { scope: "document" }),
    ).toMatchObject({ clock: 0 });
  });
});

describe("the role in a pass (hosted)", () => {
  const opens = async (claims: Parameters<typeof pass>[0]) => {
    const board = `role-${crypto.randomUUID().slice(0, 8)}`;
    const { response } = await open(board, await pass({ ...claims, board }));
    return response.status;
  };

  it("takes owner, manager and write, and a pass from before roles by its owner flag", async () => {
    expect(await opens({ role: "owner" })).toBe(101);
    expect(await opens({ role: "manager" })).toBe(101);
    expect(await opens({ role: "write" })).toBe(101);
    expect(await opens({ owner: true })).toBe(101);
  });

  it("refuses a role it does not know, and a guest who is more than a guest", async () => {
    expect(await opens({ role: "admin" })).toBe(403);
    expect(await opens({ role: "shaman" })).toBe(403);
    expect(await opens({ role: "manager", sub: "g:abc" })).toBe(403);
    expect(await opens({ role: "write", sub: "g:abc" })).toBe(101);
  });
});

describe("the room and an assistant's grant", () => {
  it("refuses a grant whose person is not a manager of the board", async () => {
    const grant = { access: "write", board: "role-room", grant: 0, role: "write", title: null };
    const room = roomOf("role-room");
    expect(await room.readDocument(grant as never, { scope: "document" })).toBe("revoked");
    expect(
      await room.commitDocument(grant as never, {
        absent: [],
        puts: [],
        removes: [],
        since: 0,
        unchanged: [],
      }),
    ).toBe("revoked");
  });
});
