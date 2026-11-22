// The dice as plain data: each a convex polyhedron with rounded edges (its
// shrunk "core" swept by a ball of radius r), its faces, and which value each
// face (a d4: each corner) shows. Coordinates are closed forms in square
// roots, so every engine builds the same numbers (see dice-math.ts).

import { add, cross, dot, length, normalize, scale, sub, type Vec } from "./dice-math";

export type DieKind = "d4" | "d6" | "d8" | "d10" | "d12" | "d20" | "d100";

export type Face = { center: Vec; normal: Vec; verts: number[] };

// What a die shows when `dir` (model space) points straight up: a face's
// outward normal, or for a d4 a corner's direction.
export type Feature = { dir: Vec; ring: Vec[]; text: string; up: Vec | null; value: number };

export type Solid = {
  core: Vec[];
  faces: Face[];
  // The numeral's "up" on each face, in the face plane.
  faceUp: Vec[];
  features: Feature[];
  inradius: number;
  kind: DieKind;
  // Rounding radius.
  r: number;
  // Circumradius of the rounded die.
  radius: number;
  verts: Vec[];
};

const SQRT5 = Math.sqrt(5);
const PHI = (1 + SQRT5) / 2;
const COS36 = (1 + SQRT5) / 4;
const SIN36 = Math.sqrt(10 - 2 * SQRT5) / 4;
const COS72 = (SQRT5 - 1) / 4;
const SIN72 = Math.sqrt(10 + 2 * SQRT5) / 4;
// Multiples of 36°, as [cos, sin].
const RING: [number, number][] = [
  [1, 0],
  [COS36, SIN36],
  [COS72, SIN72],
  [-COS72, SIN72],
  [-COS36, SIN36],
  [-1, 0],
  [-COS36, -SIN36],
  [-COS72, -SIN72],
  [COS72, -SIN72],
  [COS36, -SIN36],
];
// Pentagonal trapezohedron: the kites are planar when apex = z0 (1 + cos 36°) / (1 - cos 36°).
const D10_RING_HEIGHT = 0.105;

// Circumradius of the sharp solid, and the rounding as a share of it.
const SIZE: Record<DieKind, number> = {
  d4: 1.05,
  d6: 0.92,
  d8: 0.98,
  d10: 0.98,
  d12: 0.98,
  d20: 1,
  d100: 0.98,
};
const ROUNDING: Record<DieKind, number> = {
  d4: 0.13,
  d6: 0.17,
  d8: 0.11,
  d10: 0.09,
  d12: 0.08,
  d20: 0.07,
  d100: 0.09,
};

const SIGNS = [1, -1];
const cube = (): Vec[] =>
  SIGNS.flatMap((x) => SIGNS.flatMap((y) => SIGNS.map((z): Vec => [x, y, z])));

function sharpVerts(kind: DieKind): Vec[] {
  switch (kind) {
    case "d4": {
      return [
        [1, 1, 1],
        [1, -1, -1],
        [-1, 1, -1],
        [-1, -1, 1],
      ];
    }
    case "d6": {
      return cube();
    }
    case "d8": {
      return [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
    }
    case "d10":
    case "d100": {
      const apex = (D10_RING_HEIGHT * (1 + COS36)) / (1 - COS36);
      return [
        [0, apex, 0],
        [0, -apex, 0],
        ...RING.map(([c, s], k): Vec => [c, k % 2 === 0 ? D10_RING_HEIGHT : -D10_RING_HEIGHT, s]),
      ];
    }
    case "d12": {
      return [
        ...cube(),
        ...SIGNS.flatMap((a) =>
          SIGNS.flatMap((b): Vec[] => [
            [0, a / PHI, b * PHI],
            [a / PHI, b * PHI, 0],
            [a * PHI, 0, b / PHI],
          ]),
        ),
      ];
    }
    case "d20": {
      return SIGNS.flatMap((a) =>
        SIGNS.flatMap((b): Vec[] => [
          [0, a, b * PHI],
          [a, b * PHI, 0],
          [a * PHI, 0, b],
        ]),
      );
    }
  }
}

// A monotonic stand-in for atan2 that needs no trigonometry.
export function pseudoAngle(x: number, y: number): number {
  const p = y / (Math.abs(x) + Math.abs(y));
  if (x < 0) return 2 - p;
  return p < 0 ? 4 + p : p;
}

const EPSILON = 1e-9;

// Every plane through three vertices that has all vertices on one side is a
// face; its vertices are ordered counter-clockwise seen from outside.
function facesOf(verts: Vec[]): Face[] {
  const faces: Face[] = [];
  const count = verts.length;
  for (let i = 0; i < count; i += 1)
    for (let j = i + 1; j < count; j += 1)
      for (let k = j + 1; k < count; k += 1) {
        const c = cross(sub(verts[j]!, verts[i]!), sub(verts[k]!, verts[i]!));
        if (length(c) < EPSILON) continue;
        const raw = normalize(c);
        const normal = dot(raw, verts[i]!) < 0 ? scale(raw, -1) : raw;
        const offset = dot(normal, verts[i]!);
        if (!verts.every((v) => dot(normal, v) <= offset + EPSILON)) continue;
        if (faces.some((face) => dot(face.normal, normal) > 1 - EPSILON)) continue;
        const on = verts.flatMap((v, index) =>
          Math.abs(dot(normal, v) - offset) < 1e-7 ? [index] : [],
        );
        let sum: Vec = [0, 0, 0];
        for (const index of on) sum = add(sum, verts[index]!);
        const center = scale(sum, 1 / on.length);
        const ref = normalize(sub(verts[on[0]!]!, center));
        const side = cross(normal, ref);
        const angle = (index: number) => {
          const d = sub(verts[index]!, center);
          return pseudoAngle(dot(d, ref), dot(d, side));
        };
        const ordered = [...on];
        ordered.sort((a, b) => angle(a) - angle(b));
        faces.push({ center, normal, verts: ordered });
      }
  return faces;
}

type Label = { text: string; value: number };

// Opposite faces sum to n + 1 (a d10's digits to 9), as on real dice.
function faceLabels(kind: DieKind, faces: Face[]): Label[] {
  const labels: Label[] = Array.from({ length: faces.length });
  const taken = new Set<number>();
  const label = (k: number): [Label, Label] => {
    if (kind === "d10")
      return [
        { text: String(k), value: k === 0 ? 10 : k },
        { text: String(9 - k), value: 9 - k === 0 ? 10 : 9 - k },
      ];
    if (kind === "d100")
      return [
        { text: `${k}0`, value: k === 0 ? 100 : k * 10 },
        { text: `${9 - k}0`, value: 9 - k === 0 ? 100 : (9 - k) * 10 },
      ];
    return [
      { text: String(k + 1), value: k + 1 },
      { text: String(faces.length - k), value: faces.length - k },
    ];
  };
  let next = 0;
  for (const [i, face] of faces.entries()) {
    if (taken.has(i)) continue;
    const j = faces.findIndex((other) => dot(other.normal, face.normal) < -1 + EPSILON);
    taken.add(i).add(j);
    [labels[i], labels[j]] = label(next);
    next += 1;
  }
  return labels;
}

function numeralUp(kind: DieKind, verts: Vec[], face: Face): Vec {
  const first = verts[face.verts[0]!]!;
  let toward = first;
  // A d6 numeral sits square to an edge, a d10's points to the pole.
  if (kind === "d6") toward = scale(add(first, verts[face.verts[1]!]!), 0.5);
  if (kind === "d10" || kind === "d100")
    for (const index of face.verts)
      if (Math.abs(verts[index]![1]) > Math.abs(toward[1])) toward = verts[index]!;
  const up = sub(toward, face.center);
  return normalize(sub(up, scale(face.normal, dot(up, face.normal))));
}

const solids = new Map<DieKind, Solid>();

export function solid(kind: DieKind): Solid {
  const known = solids.get(kind);
  if (known !== undefined) return known;
  const raw = sharpVerts(kind);
  const reach = Math.max(...raw.map(length));
  const verts = raw.map((v) => scale(v, SIZE[kind] / reach));
  const faces = facesOf(verts);
  const inradius = dot(faces[0]!.normal, faces[0]!.center);
  const r = ROUNDING[kind] * SIZE[kind];
  const core = verts.map((v) => scale(v, (inradius - r) / inradius));
  const faceUp = faces.map((face) => numeralUp(kind, verts, face));
  const labels = kind === "d4" ? [] : faceLabels(kind, faces);
  const features: Feature[] =
    kind === "d4"
      ? verts.map((v, i) => ({
          dir: normalize(v),
          ring: verts.filter((_, j) => j !== i),
          text: String(i + 1),
          up: null,
          value: i + 1,
        }))
      : faces.map((face, i) => ({
          ...labels[i]!,
          dir: face.normal,
          ring: face.verts.map((v) => verts[v]!),
          up: faceUp[i]!,
        }));
  const made: Solid = {
    core,
    faces,
    faceUp,
    features,
    inradius,
    kind,
    r,
    radius: Math.max(...core.map(length)) + r,
    verts,
  };
  solids.set(kind, made);
  return made;
}
