import { expect, it } from "vitest";

import { call, pass, seat, until } from "./support";

it("lets owners and managers summon a single participant in their room", async () => {
  const board = "summon";
  const [ownerPass, managerPass, guestPass, otherPass] = await Promise.all([
    pass({ board, owner: true }),
    pass({ board, role: "manager", sub: "a:manager" }),
    pass({ board, sub: "g:summon" }),
    pass({ board, sub: "g:other" }),
  ]);
  const [owner, guest, other] = await Promise.all([
    seat(board, ownerPass),
    seat(board, guestPass),
    seat(board, otherPass),
  ]);
  const view = { page: "page:page", x: -300, y: 200, zoom: 1.5 };
  const destination = { ...view, target: "g:summon" };
  const send = (token: string, body: object) =>
    call(`/rooms/${board}/summon`, token, { body: JSON.stringify(body), method: "POST" });
  const messages = (connection: typeof guest) =>
    connection.received.filter((message) => message.type === "custom");

  expect((await send(guestPass, destination)).status).toBe(403);
  expect((await send(ownerPass, view)).status).toBe(400);
  expect((await send(ownerPass, { ...destination, zoom: 0 })).status).toBe(400);
  expect((await send(ownerPass, { ...destination, page: "page:missing" })).status).toBe(409);
  expect((await send(ownerPass, { ...destination, target: "g:absent" })).status).toBe(409);
  expect((await send(ownerPass, destination)).status).toBe(204);
  await until(() => messages(guest).length === 1);

  expect((await send(managerPass, { ...destination, target: "g:other" })).status).toBe(204);
  await until(() => messages(other).length === 1);
  const expected = [{ data: { ...view, type: "summon" }, type: "custom" }];
  expect(messages(guest)).toEqual(expected);
  expect(messages(other)).toEqual(expected);
  expect(messages(owner)).toEqual([]);
});
