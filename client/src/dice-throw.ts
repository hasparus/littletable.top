// From a roll to what every screen plays: which bodies are thrown, the frames
// of the shared throw, and for each die the turn of its numbering that puts
// the server's value on top. No rendering here.

import {
  cross,
  dot,
  fromBasis,
  multiply,
  normalize,
  type Quat,
  rotate,
  scale,
  sub,
  type Vec,
} from "./dice-math";
import { simulation, type Simulation, type Throw } from "./dice-physics";
import { type DieKind, type Feature, solid, type Solid } from "./dice-solids";

export type Die = { sides: number; value: number };
export type ThrownDie = { kind: DieKind; value: number };

export const bodiesOf = (dice: Die[]): ThrownDie[] =>
  dice.map(({ sides, value }) => ({ kind: `d${sides}` as DieKind, value }));

const basis = (dir: Vec, ring: Vec): [Vec, Vec, Vec] => {
  const n = normalize(dir);
  const w = normalize(sub(ring, scale(n, dot(ring, n))));
  return [n, w, cross(n, w)];
};

// The point p under the rotation that takes frame `from` onto frame `to`.
const carry = (to: [Vec, Vec, Vec], from: [Vec, Vec, Vec], p: Vec): Vec => {
  const c = [dot(from[0], p), dot(from[1], p), dot(from[2], p)] as const;
  return [0, 1, 2].map(
    (axis) => to[0][axis]! * c[0] + to[1][axis]! * c[1] + to[2][axis]! * c[2],
  ) as Vec;
};

const SCREEN_UP: Vec = [0, 0, -1];

function landedFeature(shape: Solid, rotation: Quat): Feature {
  let best = shape.features[0]!;
  let height = -2;
  for (const feature of shape.features) {
    const y = rotate(rotation, feature.dir)[1];
    if (y > height) [height, best] = [y, feature];
  }
  return best;
}

// A rotation of the solid onto itself, applied to the mesh alone, that puts
// the face showing `value` where the landed face is. The silhouette does not
// change, so the recorded throw stays true. Of the candidates it picks the
// one whose numeral reads most upright on screen. A ball is the same seen
// from anywhere, so its numbering turns freely: the value goes straight up,
// upright.
export function numbering(kind: DieKind, rotation: Quat, value: number): Quat {
  const shape = solid(kind);
  if (shape.ball) {
    const target = shape.features.find((feature) => feature.value === value);
    if (target === undefined || target.up === null)
      throw new Error(`a ${kind} cannot show ${value}`);
    const from = basis(target.dir, target.up);
    const to = basis([0, 1, 0], SCREEN_UP);
    const upright = fromBasis(
      carry(to, from, [1, 0, 0]),
      carry(to, from, [0, 1, 0]),
      carry(to, from, [0, 0, 1]),
    );
    return multiply([-rotation[0], -rotation[1], -rotation[2], rotation[3]], upright);
  }
  const landed = landedFeature(shape, rotation);
  let pick: Quat | null = null;
  let score = Number.NEGATIVE_INFINITY;
  for (const target of shape.features.filter((feature) => feature.value === value)) {
    const from = basis(target.dir, target.ring[0]!);
    for (const corner of landed.ring) {
      const to = basis(landed.dir, corner);
      const symmetric = shape.verts.every((p) => {
        const moved = carry(to, from, p);
        return shape.verts.some((q) => dot(sub(q, moved), sub(q, moved)) < 1e-6);
      });
      if (!symmetric) continue;
      const turn = fromBasis(
        carry(to, from, [1, 0, 0]),
        carry(to, from, [0, 1, 0]),
        carry(to, from, [0, 0, 1]),
      );
      const upright =
        target.up === null ? 0 : dot(rotate(rotation, rotate(turn, target.up)), SCREEN_UP);
      if (upright > score) [score, pick] = [upright, turn];
    }
  }
  if (pick === null) throw new Error(`a ${kind} cannot show ${value}`);
  return pick;
}

export type Planned = { bodies: ThrownDie[]; numbering: Quat[]; thrown: Throw };

export function finalRotation(thrown: Throw, index: number): Quat {
  const frames = thrown.frames[index]!;
  const last = frames.length - 4;
  return [frames[last]!, frames[last + 1]!, frames[last + 2]!, frames[last + 3]!];
}

// Throws `dice` with `seed`. The simulation may pause at `deadline`s; call
// `advance` until it reports done, then `planned`.
export function throwDice(
  dice: Die[],
  seed: number,
): { advance: Simulation["advance"]; planned: () => Planned } {
  const bodies = bodiesOf(dice);
  const run = simulation(
    bodies.map((body) => body.kind),
    seed,
  );
  return {
    advance: run.advance,
    planned: () => {
      const thrown = run.result();
      return {
        bodies,
        numbering: bodies.map((body, i) =>
          numbering(body.kind, finalRotation(thrown, i), body.value),
        ),
        thrown,
      };
    },
  };
}
