import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import type { BoardRoom } from "../src/board-room";

import { call, pass, seat, until } from "./support";

type Seat = Awaited<ReturnType<typeof seat>>;

it.each([0, 1])(
  "converges on saved pages and live summon recipients, schedule %i",
  async (order) => {
    const board = `view-model-${order}`;
    const owner = await pass({ board, owner: true });
    const target = "g:viewer";
    const viewer = await pass({ board, sub: target });
    const namespace = (env as unknown as { BoardRoom: DurableObjectNamespace<BoardRoom> })
      .BoardRoom;
    const room = namespace.get(namespace.idFromName(board));
    const pages = new Map<string, string>();
    const sockets = new Set<Seat>();
    const recipients = new Set<Seat>();
    const deliveries = new Map<Seat, object[]>();
    const trace: string[] = [];

    async function join(token: string) {
      trace.push(token === viewer ? "join viewer" : "join owner");
      const socket = await seat(board, token);
      sockets.add(socket);
      if (token === viewer) recipients.add(socket);
      deliveries.set(socket, []);
      const snapshot = socket.received.find((event) => event.type === "connect") as unknown as {
        diff: Record<string, [string, { name: string }]>;
      };
      expect(
        Object.fromEntries(
          Object.entries(snapshot.diff)
            .filter(([id, [operation]]) => id.startsWith("page:model") && operation !== "remove")
            .map(([id, [, page]]) => [id, page.name]),
        ),
      ).toEqual(Object.fromEntries(pages));
      return socket;
    }

    async function summon(page: string, x: number) {
      trace.push(`summon ${page} at ${x}`);
      const view = { page, x, y: 0, zoom: 1 };
      const response = await call(`/rooms/${board}/summon`, owner, {
        body: JSON.stringify({ ...view, target }),
        method: "POST",
      });
      const reachable = pages.has(page) && recipients.size > 0;
      expect(response.status).toBe(reachable ? 204 : 409);
      if (reachable) {
        for (const socket of recipients) deliveries.get(socket)!.push({ ...view, type: "summon" });
      }
      for (const socket of sockets) {
        // A pong on this connection fences custom messages sent by the completed RPC.
        const from = socket.received.length;
        socket.send({ type: "ping" });
        await until(() => socket.received.slice(from).some((m) => m.type === "pong"));
        expect(socket.received.filter((m) => m.type === "custom").map((m) => m.data)).toEqual(
          deliveries.get(socket),
        );
      }
    }

    try {
      let writer = await join(owner);
      let clock = 0;
      async function edit(id: string, name?: string) {
        trace.push(`edit ${id} ${name ?? "remove"}`);
        const record = { id, index: "a2", meta: {}, name, typeName: "page" };
        writer.send({
          clientClock: ++clock,
          type: "push",
          diff: {
            [id]:
              name === undefined
                ? ["remove"]
                : pages.has(id)
                  ? ["patch", { name: ["put", name] }]
                  : ["put", record],
          },
        });
        await until(() =>
          writer.received.some(
            (m) =>
              m.type === "data" &&
              (m.data as { type: string; clientClock: number; action: string }[]).some(
                (part) =>
                  part.type === "push_result" &&
                  part.clientClock === clock &&
                  part.action === "commit",
              ),
          ),
        );
        if (name === undefined) pages.delete(id);
        else pages.set(id, name);
      }

      const page = "page:model-a";
      await edit(page, "First");
      await summon(page, 0);
      const tabs = [await join(viewer), await join(viewer)];
      await summon(page, 1);
      await summon(page, 1);
      const leaving = tabs[order]!;
      trace.push(`close viewer tab ${order}`);
      leaving.close();
      await leaving.closure;
      recipients.delete(leaving);
      sockets.delete(leaving);
      await summon(page, 2);
      await edit(page, "Renamed");
      for (let restart = 0; restart < 2; restart++) {
        trace.push("restart");
        await expect(
          runInDurableObject(room, (_instance, state) => state.abort("view model restart")),
        ).rejects.toThrow("view model restart");
        for (const socket of sockets) socket.close();
        sockets.clear();
        recipients.clear();
        if (restart === order) await join(viewer);
        writer = await join(owner);
        clock = 0;
        await summon(page, 3 + restart);
        if (restart !== order) await join(viewer);
        await summon(page, 5 + restart);
        if (restart === 0) await edit(page);
      }
    } catch (cause) {
      throw new Error(`schedule ${order}: ${trace.join(" -> ")}`, { cause });
    } finally {
      for (const socket of sockets) socket.close();
    }
  },
);
