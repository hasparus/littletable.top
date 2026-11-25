import { expect, it } from "vitest";

import { call, pass, seat, until } from "./support";

it("only lets an owner summon other connections to an existing room view", async () => {
  const board = "summon";
  const [ownerPass, guestPass] = await Promise.all([
    pass({ board, owner: true }),
    pass({ board, sub: "g:summon" }),
  ]);
  const [owner, guest] = await Promise.all([seat(board, ownerPass), seat(board, guestPass)]);
  const view = { page: "page:page", x: -300, y: 200, zoom: 1.5 };
  const send = (token: string, destination: object) =>
    call(`/rooms/${board}/summon`, token, { body: JSON.stringify(destination), method: "POST" });

  expect((await send(guestPass, view)).status).toBe(403);
  expect((await send(ownerPass, { ...view, zoom: 0 })).status).toBe(400);
  expect((await send(ownerPass, { ...view, page: "page:missing" })).status).toBe(409);
  expect((await send(ownerPass, view)).status).toBe(204);

  await until(() => guest.received.some((message) => message.type === "custom"));
  expect(guest.received.filter((message) => message.type === "custom")).toEqual([
    { data: { ...view, type: "summon" }, type: "custom" },
  ]);
  expect(owner.received.some((message) => message.type === "custom")).toBe(false);
});
