import type { DiceLaunch } from "../../src/dice-notation";

import {
  cross,
  dot,
  fromBasis,
  normalize,
  type Quat,
  rotate,
  rotationBetween,
  scale,
  sub,
  type Vec,
} from "./dice-math";
import { FRAME_STRIDE, simulation, type Simulation, type Throw } from "./dice-physics";
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

const carry = (to: [Vec, Vec, Vec], from: [Vec, Vec, Vec], p: Vec): Vec => {
  const c = [dot(from[0], p), dot(from[1], p), dot(from[2], p)] as const;
  return [0, 1, 2].map(
    (axis) => to[0][axis]! * c[0] + to[1][axis]! * c[1] + to[2][axis]! * c[2],
  ) as Vec;
};

function landedFeature(shape: Solid, rotation: Quat): Feature {
  let best = shape.features[0]!;
  let height = -2;
  for (const feature of shape.features) {
    const y = rotate(rotation, feature.dir)[1];
    if (y > height) [height, best] = [y, feature];
  }
  return best;
}

/** Rotates the mesh onto itself to show the value without changing the recorded trajectory. */
export function numbering(kind: DieKind, rotation: Quat, value: number): Quat {
  const shape = solid(kind);
  if (shape.ball) {
    const target = shape.features.find((feature) => feature.value === value);
    if (target === undefined || target.up === null)
      throw new Error(`a ${kind} cannot show ${value}`);
    const up = rotate([-rotation[0], -rotation[1], -rotation[2], rotation[3]], [0, 1, 0]);
    if (dot(up, target.dir) > -0.999999) return rotationBetween(target.dir, up);
    const from = basis(target.dir, target.up);
    const to = basis(up, target.up);
    return fromBasis(
      carry(to, from, [1, 0, 0]),
      carry(to, from, [0, 1, 0]),
      carry(to, from, [0, 0, 1]),
    );
  }
  const landed = landedFeature(shape, rotation);
  for (const target of shape.features.filter((feature) => feature.value === value)) {
    const from = basis(target.dir, target.ring[0]!);
    for (const corner of landed.ring) {
      const to = basis(landed.dir, corner);
      const symmetric = shape.verts.every((p) => {
        const moved = carry(to, from, p);
        return shape.verts.some((q) => dot(sub(q, moved), sub(q, moved)) < 1e-6);
      });
      if (!symmetric) continue;
      return fromBasis(
        carry(to, from, [1, 0, 0]),
        carry(to, from, [0, 1, 0]),
        carry(to, from, [0, 0, 1]),
      );
    }
  }
  throw new Error(`a ${kind} cannot show ${value}`);
}

export type Planned = { bodies: ThrownDie[]; numbering: Quat[]; thrown: Throw };

/** Corrects the d100 orientation so the result is centred in its camera projection. */
export function cameraFacingOf({ bodies, thrown }: Planned, eye: Vec): (Quat | null)[] {
  return bodies.map((body, index) => {
    if (!solid(body.kind).ball) return null;
    const frames = thrown.frames[index]!;
    const at = frames.length - FRAME_STRIDE;
    const rest: Vec = [frames[at]!, frames[at + 1]!, frames[at + 2]!];
    return rotationBetween([0, 1, 0], normalize(sub(eye, rest)));
  });
}

export function finalRotation(thrown: Throw, index: number): Quat {
  const frames = thrown.frames[index]!;
  const last = frames.length - 4;
  return [frames[last]!, frames[last + 1]!, frames[last + 2]!, frames[last + 3]!];
}

/** Call advance to completion before reading planned. */
export function throwDice(
  dice: Die[],
  seed: number,
  launch?: DiceLaunch,
): { advance: Simulation["advance"]; planned: () => Planned } {
  const bodies = bodiesOf(dice);
  const run = simulation(
    bodies.map((body) => body.kind),
    seed,
    launch,
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
