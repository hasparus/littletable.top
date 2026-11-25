import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { expect, it } from "vitest";

import { call, linkReset, open, pass, seat, until } from "./support";

type Command = { kind: "connect"; link: number; sub: string } | { kind: "reset"; link: number };

const SEEDS = [1, 42, 4_294_967_295];
const FORBIDDEN = {
  code: TLSyncErrorCloseEventCode,
  reason: TLSyncErrorCloseEventReason.FORBIDDEN,
};
const GUEST = "g:visitor";
const MEMBER = "u:member";

function* commandsFrom(seed: number): Generator<Command> {
  let state = seed;
  let link = 0;
  yield { kind: "connect", link, sub: GUEST };
  yield { kind: "connect", link, sub: MEMBER };

  for (let round = 0; round < 4; round++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const nextLink = link + 1 + ((state >>> 17) % 3);
    const reset = { kind: "reset", link: nextLink } as const;
    const reconnect = { kind: "connect", link: nextLink, sub: MEMBER } as const;
    const passFirst = (round + (seed & 1)) % 2 === 0;
    yield passFirst ? reconnect : reset;
    yield { kind: "connect", link, sub: GUEST };
    yield passFirst ? reset : reconnect;
    yield { kind: "reset", link: Math.max(1, link) };
    yield { kind: "connect", link: nextLink, sub: GUEST };
    link = nextLink;
  }
}

it.each(SEEDS)("replays the board link lifecycle with seed %i", async (seed) => {
  const board = `link-model-${seed}`;
  let latest = 0;
  const versions = new Map<number, number>();
  const sockets = new Map<number, Awaited<ReturnType<typeof seat>>>();

  try {
    for (const [index, command] of [...commandsFrom(seed)].entries()) {
      const { link } = command;
      const context = `seed ${seed}, command ${index + 1}: ${JSON.stringify(command)}`;

      try {
        if (command.kind === "reset") {
          const token = await linkReset({ board, link });
          const response = await call(`/rooms/${board}/link`, token, { method: "POST" });
          expect(response.status).toBe(204);
        } else {
          const token = await pass({ board, link, sub: command.sub });
          if (link < latest) {
            const rejected = await open(board, token);
            expect(rejected.response.status).toBe(101);
            let closure: Awaited<typeof rejected.closure> | undefined;
            void rejected.closure.then((event) => (closure = event));
            await until(() => closure !== undefined);
            expect(closure).toEqual(FORBIDDEN);
          } else {
            sockets.set(index, await seat(board, token));
            versions.set(index, link);
          }
        }

        latest = Math.max(latest, link);
        for (const [id, socket] of sockets) {
          if (versions.get(id)! < latest) {
            await until(socket.isClosed);
            expect(await socket.closure).toEqual(FORBIDDEN);
            sockets.delete(id);
            versions.delete(id);
          } else {
            const before = socket.received.length;
            socket.send({ type: "ping" });
            await until(() => socket.received.slice(before).some(({ type }) => type === "pong"));
          }
        }
      } catch (cause) {
        throw new Error(context, { cause });
      }
    }
  } finally {
    for (const socket of sockets.values()) socket.close();
  }
});
