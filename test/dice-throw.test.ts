import { describe, expect, it } from "vitest";

import type { DieKind } from "../client/src/dice-solids";

import { add, cross, multiply, rotate, scale } from "../client/src/dice-math";
import {
  FRAME_STRIDE,
  hashThrow,
  simulate,
  TRAY_DEPTH,
  TRAY_WIDTH,
} from "../client/src/dice-physics";
import { solid } from "../client/src/dice-solids";
import {
  bodiesOf,
  finalRotation,
  numbering,
  throwDice,
  uprightTurn,
} from "../client/src/dice-throw";

// What can go wrong with the shared throw, and what guards it here:
// - a die ends tilted, on an edge or leaning on another: "lies flat"
// - a d100, a ball with no face to lie on, never stops or leaves the tray:
//   "comes to rest", and "stays in the tray, apart" with its full radius
// - a crowd of balls has no room on the floor, so one ends on top of others
//   and is cut into them at the cap: "a crowd of balls"
// - the top face is not the server's value: "shows the server's value"
// - a die leaves the tray or ends inside another: "stays in the tray, apart"
// - a throw that never settles is cut differently on two screens: "the cap"
// - the number on top reads sideways, as a d10's would, whose numbering has
//   one way to lie: "stands the result's numeral upright"
// - the simulation changes by accident: the fixed-seed tripwire
// - a transcendental function creeps back in: test/dice-exact.test.ts
// - engines disagree: e2e/tests/dice-determinism.spec.ts runs the same
//   seeds in Chromium, Firefox and WebKit against these hashes.

const SIDES = [4, 6, 8, 10, 12, 20, 100];
const KINDS: DieKind[] = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

// Mixed pools of 1 to 20 dice.
function pool(seed: number): number[] {
  return Array.from(
    { length: 1 + (seed % 20) },
    (_, k) => SIDES[(seed * 7 + k * 3) % SIDES.length]!,
  );
}

// Pools whose balls are thrown smaller: twenty, and two mixed ones.
const CROWDS: DieKind[][] = [
  Array.from({ length: 20 }, (): DieKind => "d100"),
  Array.from({ length: 20 }, (_, i): DieKind => (i % 4 === 3 ? "d20" : "d100")),
  Array.from({ length: 20 }, (_, i): DieKind => (i % 2 === 0 ? "d100" : "d12")),
];

const SEEDS = Array.from({ length: 40 }, (_, i) => Math.imul(i + 1, 2_654_435_761) >>> 0);

function lastPosition(frames: Float64Array): [number, number, number] {
  const at = frames.length - FRAME_STRIDE;
  return [frames[at]!, frames[at + 1]!, frames[at + 2]!];
}

describe("the shared throw", () => {
  it.each(SEEDS)(
    "with seed %i leaves every die lying flat on a face, a ball on the floor",
    (seed) => {
      const kinds = bodiesOf(pool(seed).map((sides) => ({ sides, value: 1 }))).map(
        (body) => body.kind,
      );
      const thrown = simulate(kinds, seed);
      kinds.forEach((kind, i) => {
        const rotation = finalRotation(thrown, i);
        const shape = solid(kind);
        const lowest = Math.min(...shape.faces.map((face) => rotate(rotation, face.normal)[1]));
        expect(lowest).toBeLessThan(shape.ball ? -0.97 : -0.9994);
        expect(lastPosition(thrown.frames[i]!)[1]).toBeCloseTo(shape.inradius, 9);
      });
    },
  );

  it.each(SEEDS)("with seed %i stays in the tray, every die apart", (seed) => {
    const kinds = bodiesOf(pool(seed).map((sides) => ({ sides, value: 1 }))).map(
      (body) => body.kind,
    );
    const thrown = simulate(kinds, seed);
    const ends = thrown.frames.map(lastPosition);
    ends.forEach(([x, , z], i) => {
      // A ball is all inside the walls; the others' corners may lean over.
      const reach = solid(kinds[i]!).ball ? solid(kinds[i]!).inradius - 0.01 : 0;
      expect(Math.abs(x)).toBeLessThan(TRAY_WIDTH / 2 - reach);
      expect(Math.abs(z)).toBeLessThan(TRAY_DEPTH / 2 - reach);
    });
    ends.forEach((a, i) =>
      ends.slice(i + 1).forEach((b, k) => {
        const gap = Math.hypot(a[0] - b[0], a[2] - b[2]);
        const touch = (solid(kinds[i]!).inradius + solid(kinds[i + 1 + k]!).inradius) * 0.9;
        expect(gap).toBeGreaterThan(touch);
      }),
    );
  });

  it.each(SEEDS.slice(0, 20))("with seed %i a d100 among other dice comes to rest", (seed) => {
    const thrown = simulate(["d100", "d6", "d100", "d20", "d8"], seed);
    expect(thrown.settledAt).toBeLessThan(3.2);
    // Still across the floor and in its turning over the last two frames.
    for (const frames of [thrown.frames[0]!, thrown.frames[2]!]) {
      const last = [...frames.slice(-FRAME_STRIDE)];
      const before = [...frames.slice(-2 * FRAME_STRIDE, -FRAME_STRIDE)];
      for (const at of [0, 2, 3, 4, 5, 6]) expect(before[at]).toBeCloseTo(last[at]!, 9);
    }
  });

  it("throws balls at their full size until they crowd the tray", () => {
    const sizes = (kinds: DieKind[]) => simulate(kinds, 3).sizes;
    expect(sizes(["d100", "d20"])).toEqual([1, 1]);
    expect(sizes(Array.from({ length: 13 }, () => "d100"))).toEqual(Array(13).fill(1));
    expect(sizes(Array.from({ length: 20 }, () => "d100"))[0]).toBeCloseTo(1 / 1.2, 12);
    const mixed = sizes([...CROWDS[2]!]);
    expect(mixed[0]).toBeGreaterThan(1 / 1.2);
    expect(mixed[0]).toBeLessThan(1);
    expect(mixed[1]).toBe(1);
  });

  it.each(SEEDS.slice(0, 12))(
    "with seed %i a crowd of balls comes to rest by itself, apart, on the floor",
    (seed) => {
      // Twenty balls have until 4.2 s.
      expect(simulate(CROWDS[0]!, seed).settledAt).toBeLessThan(4.2);
      for (const kinds of CROWDS) {
        const thrown = simulate(kinds, seed);
        const ends = thrown.frames.map(lastPosition);
        const reach = kinds.map((kind, i) => solid(kind).inradius * thrown.sizes[i]!);
        ends.forEach(([x, y, z], i) => {
          expect(y).toBeCloseTo(reach[i]!, 9);
          expect(Math.abs(x)).toBeLessThan(TRAY_WIDTH / 2 - reach[i]! + 0.01);
          expect(Math.abs(z)).toBeLessThan(TRAY_DEPTH / 2 - reach[i]! + 0.01);
          ends.slice(i + 1).forEach((other, k) => {
            const touch = (reach[i]! + reach[i + 1 + k]!) * 0.98;
            expect(Math.hypot(x - other[0], z - other[2])).toBeGreaterThan(touch);
          });
        });
      }
    },
  );

  it.each(KINDS)("puts every value of a %s on top", (kind) => {
    const shape = solid(kind);
    const values = [...new Set(shape.features.map((feature) => feature.value))];
    const thrown = simulate([kind], 7);
    const rotation = finalRotation(thrown, 0);
    for (const value of values) {
      const shown = multiply(rotation, numbering(kind, rotation, value));
      const top = shape.features.reduce((a, b) =>
        rotate(shown, b.dir)[1] > rotate(shown, a.dir)[1] ? b : a,
      );
      expect(top.value).toBe(value);
      expect(rotate(shown, top.dir)[1]).toBeGreaterThan(0.999);
    }
  });

  it.each(KINDS.slice(1, 6))("stands the result's numeral upright on a %s", (kind) => {
    const shape = solid(kind);
    for (const seed of SEEDS.slice(0, 10)) {
      const rotation = finalRotation(simulate([kind], seed), 0);
      const { value } = shape.features[seed % shape.features.length]!;
      const turn = numbering(kind, rotation, value);
      const upright = uprightTurn(kind, { rotation, turn, value })!;
      const top = shape.features[upright.face]!;
      expect(top.value).toBe(value);
      // The numeral's up once turned by that much on its face; z runs down
      // the screen.
      const right = cross(top.up!, top.dir);
      const up = add(scale(top.up!, upright.cos), scale(right, upright.sin));
      expect(rotate(multiply(rotation, turn), up)[2]).toBeCloseTo(-1, 6);
    }
  });

  it("turns no numeral of a d4 or of a ball", () => {
    for (const kind of ["d4", "d100"] as const) {
      const rotation = finalRotation(simulate([kind], 7), 0);
      const turn = numbering(kind, rotation, 1);
      expect(uprightTurn(kind, { rotation, turn, value: 1 })).toBeNull();
    }
  });

  it("reads a d4 at the corner that points up", () => {
    const shape = solid("d4");
    const rotation = finalRotation(simulate(["d4"], 11), 0);
    for (const value of [1, 2, 3, 4]) {
      const shown = multiply(rotation, numbering("d4", rotation, value));
      const heights = shape.verts.map((corner) => rotate(shown, corner)[1]);
      expect(heights.indexOf(Math.max(...heights))).toBe(value - 1);
    }
  });

  it("shows a d100's value straight up and upright, wherever the ball stopped", () => {
    for (const value of [1, 10, 63, 90, 100]) {
      const run = throwDice([{ sides: 100, value }], 5);
      run.advance(Number.POSITIVE_INFINITY);
      const { bodies, numbering: turns, thrown } = run.planned();
      expect(bodies).toEqual([{ kind: "d100", value }]);
      const shown = multiply(finalRotation(thrown, 0), turns[0]!);
      const face = solid("d100").features.find((feature) => feature.value === value)!;
      expect(rotate(shown, face.dir)[1]).toBeCloseTo(1, 9);
      // z runs down the screen.
      expect(rotate(shown, face.up!)[2]).toBeCloseTo(-1, 9);
    }
  });

  it("gives the d100 a hundred faces, each its own number", () => {
    const { faces, features } = solid("d100");
    expect(faces).toHaveLength(100);
    expect(new Set(features.map((feature) => feature.value))).toEqual(
      new Set(Array.from({ length: 100 }, (_, i) => i + 1)),
    );
  });

  // Seed and pool found by search: a throw that is still moving at the cap.
  it("cuts a throw that will not settle at the cap, the same way every time", () => {
    const kinds = bodiesOf(
      [20, 8, 20, 8, 20, 8, 20, 8, 20, 8, 20, 8, 20, 8, 20, 8, 20, 8].map((sides) => ({
        sides,
        value: 1,
      })),
    ).map((body) => body.kind);
    const thrown = simulate(kinds, 1_057_067_124);
    expect(thrown.snapped).toBeGreaterThan(0);
    expect(thrown.settledAt).toBe(3.2);
    // 3.2 s at 60 frames a second, the first frame, and the 12 eased ones.
    expect(thrown.frames[0]!.length / FRAME_STRIDE).toBe(192 + 1 + 12);
    kinds.forEach((kind, i) => {
      const rotation = finalRotation(thrown, i);
      const lowest = Math.min(...solid(kind).faces.map((face) => rotate(rotation, face.normal)[1]));
      expect(lowest).toBeLessThan(-0.999_999);
    });
    expect(hashThrow(simulate(kinds, 1_057_067_124))).toBe(hashThrow(thrown));
  });

  it("throws a d100 as one die", () => {
    expect(bodiesOf([{ sides: 100, value: 63 }])).toEqual([{ kind: "d100", value: 63 }]);
  });

  it("makes the same frames however the work is split", () => {
    const dice = pool(19).map((sides) => ({ sides, value: 1 }));
    const whole = throwDice(dice, 1234);
    whole.advance(Number.POSITIVE_INFINITY);
    const sliced = throwDice(dice, 1234);
    let slices = 0;
    while (!sliced.advance(0)) slices += 1;
    expect(slices).toBeGreaterThan(10);
    expect(hashThrow(sliced.planned().thrown)).toBe(hashThrow(whole.planned().thrown));
  });

  // NOTE: a tripwire, not a specification. These hashes change whenever the
  // simulation, the solids or the throw's start change. Update them only in
  // a commit that changes those on purpose, after the cross-engine e2e
  // (e2e/tests/dice-determinism.spec.ts) agrees on the new values; every
  // client of a board must run the same simulation.
  it("throws as it always has", () => {
    // NOTE: the two with a d100 changed when it became a ball; the two
    // without are as they were before it.
    expect(hashThrow(simulate(KINDS, 7))).toBe("0d2cc80e");
    expect(hashThrow(simulate(["d100"], 2_026))).toBe("76bc62aa");
    expect(hashThrow(simulate(KINDS.slice(0, 6), 7))).toBe("2e06c497");
    expect(hashThrow(simulate(["d20"], 2_026))).toBe("e4fe3cb2");
    // NOTE: crowds, whose balls are thrown smaller; pinned when that began.
    expect(CROWDS.map((kinds) => hashThrow(simulate(kinds, 7)))).toEqual([
      "6d78f8a6",
      "239f70ee",
      "7ebfc92c",
    ]);
  });
});
