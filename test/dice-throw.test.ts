import { describe, expect, it } from "vitest";

import type { DieKind } from "../client/src/dice-solids";

import { multiply, rotate } from "../client/src/dice-math";
import {
  FRAME_STRIDE,
  hashThrow,
  simulate,
  TRAY_DEPTH,
  TRAY_WIDTH,
} from "../client/src/dice-physics";
import { solid } from "../client/src/dice-solids";
import { bodiesOf, finalRotation, numbering, throwDice } from "../client/src/dice-throw";

// What can go wrong with the shared throw, and what guards it here:
// - a die ends tilted, on an edge or leaning on another: "lies flat"
// - the top face is not the server's value: "shows the server's value"
// - a die leaves the tray or ends inside another: "stays in the tray, apart"
// - a throw that never settles is cut differently on two screens: "the cap"
// - the simulation changes by accident: the fixed-seed tripwire
// - a transcendental function creeps back in: test/dice-exact.test.ts
// - engines disagree: e2e/tests/dice-determinism.spec.ts runs the same
//   seeds in Chromium, Firefox and WebKit against these hashes.

const SIDES = [4, 6, 8, 10, 12, 20, 100];
const KINDS: DieKind[] = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

// Mixed pools of 1 to 20 dice, d100s counting twice.
function pool(seed: number): number[] {
  return Array.from(
    { length: 1 + (seed % 20) },
    (_, k) => SIDES[(seed * 7 + k * 3) % SIDES.length]!,
  );
}

const SEEDS = Array.from({ length: 40 }, (_, i) => Math.imul(i + 1, 2_654_435_761) >>> 0);

function lastPosition(frames: Float64Array): [number, number, number] {
  const at = frames.length - FRAME_STRIDE;
  return [frames[at]!, frames[at + 1]!, frames[at + 2]!];
}

describe("the shared throw", () => {
  it.each(SEEDS)("with seed %i leaves every die lying flat on a face", (seed) => {
    const kinds = bodiesOf(pool(seed).map((sides) => ({ sides, value: 1 }))).map(
      (body) => body.kind,
    );
    const thrown = simulate(kinds, seed);
    kinds.forEach((kind, i) => {
      const rotation = finalRotation(thrown, i);
      const shape = solid(kind);
      const lowest = Math.min(...shape.faces.map((face) => rotate(rotation, face.normal)[1]));
      expect(lowest).toBeLessThan(-0.9994);
      expect(lastPosition(thrown.frames[i]!)[1]).toBeCloseTo(shape.inradius, 9);
    });
  });

  it.each(SEEDS)("with seed %i stays in the tray, every die apart", (seed) => {
    const kinds = bodiesOf(pool(seed).map((sides) => ({ sides, value: 1 }))).map(
      (body) => body.kind,
    );
    const thrown = simulate(kinds, seed);
    const ends = thrown.frames.map(lastPosition);
    for (const [x, , z] of ends) {
      expect(Math.abs(x)).toBeLessThan(TRAY_WIDTH / 2);
      expect(Math.abs(z)).toBeLessThan(TRAY_DEPTH / 2);
    }
    ends.forEach((a, i) =>
      ends.slice(i + 1).forEach((b, k) => {
        const gap = Math.hypot(a[0] - b[0], a[2] - b[2]);
        const touch = (solid(kinds[i]!).inradius + solid(kinds[i + 1 + k]!).inradius) * 0.9;
        expect(gap).toBeGreaterThan(touch);
      }),
    );
  });

  it("throws twenty d100s (forty dice) and lands them all", () => {
    const dice = Array.from({ length: 20 }, (_, i) => ({ sides: 100, value: i * 5 + 1 }));
    const run = throwDice(dice, 99);
    run.advance(Number.POSITIVE_INFINITY);
    const { bodies, thrown } = run.planned();
    expect(bodies).toHaveLength(40);
    expect(thrown.settledAt).toBeLessThan(3.2);
  });

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

  it("reads a d4 at the corner that points up", () => {
    const shape = solid("d4");
    const rotation = finalRotation(simulate(["d4"], 11), 0);
    for (const value of [1, 2, 3, 4]) {
      const shown = multiply(rotation, numbering("d4", rotation, value));
      const heights = shape.verts.map((corner) => rotate(shown, corner)[1]);
      expect(heights.indexOf(Math.max(...heights))).toBe(value - 1);
    }
  });

  it("shows a d100 as its tens die and its units die", () => {
    for (const value of [1, 10, 63, 90, 100]) {
      const run = throwDice([{ sides: 100, value }], 5);
      run.advance(Number.POSITIVE_INFINITY);
      const { bodies, numbering: turns, thrown } = run.planned();
      const texts = bodies.map((body, i) => {
        const shown = multiply(finalRotation(thrown, i), turns[i]!);
        return solid(body.kind).features.reduce((a, b) =>
          rotate(shown, b.dir)[1] > rotate(shown, a.dir)[1] ? b : a,
        ).text;
      });
      const tens = Math.floor((value % 100) / 10);
      expect(texts).toEqual([`${tens}0`, String(value % 10)]);
    }
  });

  // Seed and pool found by search: one of 300 throws that is still moving at
  // the cap.
  it("cuts a throw that will not settle at the cap, the same way every time", () => {
    const kinds = bodiesOf(
      [4, 100, 10, 8, 20, 6, 12, 4, 100, 10, 8, 20, 6, 12, 4, 100, 10].map((sides) => ({
        sides,
        value: 1,
      })),
    ).map((body) => body.kind);
    const thrown = simulate(kinds, 2_619_514_552);
    expect(thrown.snapped).toBeGreaterThan(0);
    expect(thrown.settledAt).toBe(3.2);
    // 3.2 s at 60 frames a second, the first frame, and the 12 eased ones.
    expect(thrown.frames[0]!.length / FRAME_STRIDE).toBe(192 + 1 + 12);
    kinds.forEach((kind, i) => {
      const rotation = finalRotation(thrown, i);
      const lowest = Math.min(...solid(kind).faces.map((face) => rotate(rotation, face.normal)[1]));
      expect(lowest).toBeLessThan(-0.999_999);
    });
    expect(hashThrow(simulate(kinds, 2_619_514_552))).toBe(hashThrow(thrown));
  });

  it("throws a d100 as tens and units", () => {
    expect(bodiesOf([{ sides: 100, value: 63 }])).toEqual([
      { kind: "d100", value: 60 },
      { kind: "d10", value: 3 },
    ]);
    expect(bodiesOf([{ sides: 100, value: 100 }])).toEqual([
      { kind: "d100", value: 100 },
      { kind: "d10", value: 10 },
    ]);
    expect(bodiesOf([{ sides: 100, value: 7 }])).toEqual([
      { kind: "d100", value: 100 },
      { kind: "d10", value: 7 },
    ]);
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
    const mixed = bodiesOf(SIDES.map((sides) => ({ sides, value: 1 }))).map((body) => body.kind);
    expect(hashThrow(simulate(mixed, 7))).toBe("83b8619a");
    expect(hashThrow(simulate(["d20"], 2_026))).toBe("e4fe3cb2");
  });
});
