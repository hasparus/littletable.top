import { afterEach, expect, it, vi } from "vitest";

// Only these are exact in every JavaScript engine, so only these may run
// between a seed and the last frame of a throw (see client/src/dice-math.ts).
const EXACT = new Set(["abs", "floor", "imul", "max", "min", "sqrt"]);

afterEach(() => {
  vi.restoreAllMocks();
});

it("throws without any Math function that engines may round differently", async () => {
  const inexact = Object.getOwnPropertyNames(Math).filter(
    (name) => typeof Reflect.get(Math, name) === "function" && !EXACT.has(name),
  );
  expect(inexact).toEqual(expect.arrayContaining(["sin", "cos", "tan", "atan2", "pow", "exp"]));
  expect(inexact).toEqual(expect.arrayContaining(["log", "hypot", "cbrt", "random"]));
  for (const name of inexact) {
    vi.spyOn(Math, name as "sin").mockImplementation(() => {
      throw new Error(`Math.${name} on the simulation path`);
    });
  }
  // NOTE: imported fresh and under the stubs, so the solids' constants and
  // caches are built here too.
  vi.resetModules();
  const { throwDice } = await import("../client/src/dice-throw");
  const run = throwDice(
    [4, 6, 8, 10, 12, 20, 100].map((sides) => ({ sides, value: 1 })),
    7,
  );
  while (!run.advance(0));
  const { bodies, numbering, thrown } = run.planned();
  expect(numbering).toHaveLength(bodies.length);
  expect(thrown.frames).toHaveLength(8);
});
