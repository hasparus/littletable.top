import {
  createShapeId,
  createUserId,
  InstancePresenceRecordType,
  PageRecordType,
} from "@tldraw/tlschema";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

import type { Env } from "../src";

import { call, linkReset, pass, roll, seat, until } from "./support";

it("restores connected board sessions after eviction and delivers rolls and link resets", async () => {
  const board = "hibernated-board";
  const token = await pass({ board });
  const first = await seat(board, token);
  const second = await seat(board, await pass({ board, sub: "u:2" }));
  const { BoardRoom } = env as unknown as Env;
  const room = BoardRoom.get(BoardRoom.idFromName(board));

  await evictDurableObject(room, { webSockets: "hibernate" });
  first.send({ type: "ping" });
  await until(() => first.received.some((message) => message.type === "pong"));

  const page = {
    id: "page:after-wake",
    index: "a2",
    meta: {},
    name: "After wake",
    typeName: "page",
  };
  first.send({ clientClock: 1, diff: { [page.id]: ["put", page] }, type: "push" });
  await until(() =>
    second.received.some(
      (message) => message.type === "data" && JSON.stringify(message.data).includes(page.id),
    ),
  );

  expect((await roll(board, token, [6])).status).toBe(200);
  for (const guest of [first, second]) {
    await until(() => guest.received.some((message) => message.type === "custom"));
    expect(guest.received.find((message) => message.type === "custom")?.data).toMatchObject({
      type: "roll",
    });
    expect(guest.received.filter((message) => message.type === "connect")).toHaveLength(1);
  }

  await evictDurableObject(room, { webSockets: "hibernate" });
  const reset = await call(`/rooms/${board}/link`, await linkReset({ board, link: 1 }), {
    method: "POST",
  });
  expect(reset.status).toBe(204);
  for (const guest of [first, second]) {
    await until(guest.isClosed);
    expect(await guest.closure).toEqual({ code: 4099, reason: "FORBIDDEN" });
  }
});

it.each([1, 1000])(
  "broadcasts a deselection after sleep with %i selected shapes",
  async (count) => {
    const board = `hibernated-presence-${count}`;
    const writer = await seat(board, await pass({ board }));
    const peer = await seat(board, await pass({ board, sub: "u:2" }));
    const { BoardRoom } = env as unknown as Env;
    const room = BoardRoom.get(BoardRoom.idFromName(board));
    const selected = Array.from({ length: count }, (_, index) =>
      createShapeId(`selected-board-record-${index}`),
    );

    writer.send({
      clientClock: 1,
      presence: [
        "put",
        InstancePresenceRecordType.create({
          currentPageId: PageRecordType.createId("page"),
          id: InstancePresenceRecordType.createId(),
          selectedShapeIds: selected,
          userId: createUserId("u:1"),
          userName: "Ania",
        }),
      ],
      type: "push",
    });
    await until(() => JSON.stringify(peer.received).includes(selected.at(-1)!));
    const stored = () =>
      runInDurableObject(
        room,
        (_room, { storage }) => [...storage.kv.list({ prefix: "socketSnapshot:" })].length,
      );
    expect(await stored()).toBe(count === 1 ? 0 : 1);

    await evictDurableObject(room, { webSockets: "hibernate" });
    const start = peer.received.length;
    writer.send({
      clientClock: 2,
      presence: ["patch", { selectedShapeIds: ["put", []] }],
      type: "push",
    });
    await until(() =>
      JSON.stringify(peer.received.slice(start)).includes('"selectedShapeIds":["put",[]]'),
    );
    expect(await stored()).toBe(0);
  },
);
