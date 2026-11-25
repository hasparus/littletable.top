import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

import type { BoardRoom } from "../src/board-room";
import type { Roll } from "../src/dice-notation";

const PEOPLE = ["u:1", "u:2", "g:1"];
const SIDES = [4, 6, 8, 10, 12, 20, 100];
const DELAYS = [0, 499, 500, 501];
const SEEDS = [1, 42, 4_294_967_295];

function* rollsFrom(seed: number) {
  let state = seed;
  const pick = <T>(choices: readonly T[]): T => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return choices[(state >>> 16) % choices.length]!;
  };

  let at = 1_000_000;
  const first = { pool: [6], sub: PEOPLE[0]! };
  yield { ...first, at };
  yield { ...first, at: at + 499 };
  at += 500;
  yield { ...first, at };

  for (let turn = 0; turn < 52; turn++) {
    at += 500;
    const sub = pick(PEOPLE);
    yield { at, pool: [pick(SIDES)], sub };
    at += pick(DELAYS);
    yield { at, pool: [pick(SIDES), pick(SIDES)], sub: pick([sub, pick(PEOPLE)]) };
  }
}

function project({ at, dice, sub }: Roll) {
  return { at, pool: dice.map(({ sides }) => sides), sub };
}

it.each(SEEDS)("replays roll commands against the log model with seed %i", async (seed) => {
  const namespace = (env as unknown as { BoardRoom: DurableObjectNamespace<BoardRoom> }).BoardRoom;
  const board = `dice-model-${seed}`;
  const room = namespace.get(namespace.idFromName(board));

  await runInDurableObject(room, (instance) => {
    const accepted: ReturnType<typeof project>[] = [];
    const clock = vi.spyOn(Date, "now");
    try {
      for (const [index, command] of [...rollsFrom(seed)].entries()) {
        const { at, pool, sub } = command;
        const pass = { avatar: null, board, link: 0, name: sub, owner: false, sub };
        const context = `seed ${seed}, command ${index + 1}: ${JSON.stringify(command)}`;
        clock.mockReturnValue(at);

        const previous = accepted.findLast((entry) => entry.sub === sub);
        const ready = previous === undefined || at >= previous.at + 500;
        const result = instance.roll(pass, pool);
        if (ready) {
          accepted.push(command);
          expect(typeof result === "object" ? project(result) : result, context).toEqual(command);
        } else {
          expect(result, context).toBe("too-fast");
        }

        const history = instance.rolls(pass);
        expect(Array.isArray(history) ? history.map(project) : history, context).toEqual(
          accepted.slice(-50),
        );
      }
    } finally {
      clock.mockRestore();
    }
  });
});
