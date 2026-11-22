// From a roll to what every screen plays: which bodies are thrown, the frames
// of the shared throw, and for each die the turn of its numbering that puts
// the server's value on top. No rendering here.

import {
  cross,
  dot,
  fromBasis,
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

// A d100 is thrown as a tens die (00-90, 00 read as 100) and a units d10
// (0-9, 0 read as 10).
export function bodiesOf(dice: Die[]): ThrownDie[] {
  return dice.flatMap(({ sides, value }): ThrownDie[] => {
    if (sides !== 100) return [{ kind: `d${sides}` as DieKind, value }];
    const tens = Math.floor((value === 100 ? 0 : value) / 10) * 10;
    const units = value % 10;
    return [
      { kind: "d100", value: tens === 0 ? 100 : tens },
      { kind: "d10", value: units === 0 ? 10 : units },
    ];
  });
}

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
// one whose numeral reads most upright on screen.
export function numbering(kind: DieKind, rotation: Quat, value: number): Quat {
  const shape = solid(kind);
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
