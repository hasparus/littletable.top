import { add, cross, dot, length, lerp, normalize, scale, sub, type Vec } from "./dice-math";
import { type DieKind, pseudoAngle, solid, type Solid } from "./dice-solids";

/** Atlas cell centred on the rounded face, with in-plane axes and width in die units. */
export type Cell = { center: Vec; right: Vec; span: number; up: Vec };

export type Layout = { cells: Cell[]; columns: number; shrink: number };

export type DieMesh = {
  count: number;
  normals: Float32Array;
  positions: Float32Array;
  uvs: Float32Array;
};

const BEVEL_SEGMENTS = 6;
const BALL_BEVEL_SEGMENTS = 2;

export function layoutOf(shape: Solid): Layout {
  const shrink = (shape.inradius - shape.r) / shape.inradius;
  const cells = shape.faces.map((face, i): Cell => {
    const up = shape.faceUp[i]!;
    const reach =
      Math.max(...face.verts.map((v) => length(sub(shape.verts[v]!, face.center)))) * shrink;
    return {
      center: add(scale(face.center, shrink), scale(face.normal, shape.r)),
      right: cross(up, face.normal),
      span: reach * 2.04,
      up,
    };
  });
  return { cells, columns: Math.ceil(Math.sqrt(shape.faces.length + 1)), shrink };
}

/** Projects a point into atlas cell coordinates measured from the top-left corner. */
export function cellPoint(layout: Layout, face: number, p: Vec): [number, number] {
  const cell = layout.cells[face]!;
  const d = sub(p, cell.center);
  return [
    (face % layout.columns) + 0.5 + dot(d, cell.right) / cell.span,
    Math.floor(face / layout.columns) + 0.5 - dot(d, cell.up) / cell.span,
  ];
}

type Uv = [number, number];

export function meshOf(kind: DieKind): DieMesh {
  const shape = solid(kind);
  const layout = layoutOf(shape);
  const { columns } = layout;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const blankCell = shape.faces.length;
  const blank: Uv = [
    ((blankCell % columns) + 0.5) / columns,
    1 - (Math.floor(blankCell / columns) + 0.5) / columns,
  ];
  const blanks: [Uv, Uv, Uv] = [blank, blank, blank];
  const surface = (corner: number, normal: Vec) => add(shape.core[corner]!, scale(normal, shape.r));
  const faceUv = (face: number, p: Vec): Uv => {
    const [x, y] = cellPoint(layout, face, p);
    return [x / columns, 1 - y / columns];
  };
  const triangle = (p: [Vec, Vec, Vec], n: [Vec, Vec, Vec], uv: [Uv, Uv, Uv]) => {
    const outward = dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), add(add(n[0], n[1]), n[2])) >= 0;
    for (const k of outward ? [0, 1, 2] : [0, 2, 1]) {
      positions.push(...p[k]!);
      normals.push(...n[k]!);
      uvs.push(...uv[k]!);
    }
  };
  const segments = shape.ball ? BALL_BEVEL_SEGMENTS : BEVEL_SEGMENTS;
  const arc = (from: Vec, to: Vec) =>
    Array.from({ length: segments + 1 }, (_, t) => normalize(lerp(from, to, t / segments)));

  for (const [index, face] of shape.faces.entries()) {
    const corners = face.verts.map((v) => surface(v, face.normal));
    const flat: [Vec, Vec, Vec] = [face.normal, face.normal, face.normal];
    for (let i = 1; i + 1 < corners.length; i += 1) {
      const p: [Vec, Vec, Vec] = [corners[0]!, corners[i]!, corners[i + 1]!];
      triangle(p, flat, [faceUv(index, p[0]), faceUv(index, p[1]), faceUv(index, p[2])]);
    }
  }

  for (let a = 0; a < shape.faces.length; a += 1)
    for (let b = a + 1; b < shape.faces.length; b += 1) {
      const shared = shape.faces[a]!.verts.filter((v) => shape.faces[b]!.verts.includes(v));
      if (shared.length !== 2) continue;
      const [i, j] = shared as [number, number];
      const ns = arc(shape.faces[a]!.normal, shape.faces[b]!.normal);
      for (let t = 0; t < segments; t += 1) {
        const n0 = ns[t]!;
        const n1 = ns[t + 1]!;
        triangle([surface(i, n0), surface(j, n0), surface(j, n1)], [n0, n0, n1], blanks);
        triangle([surface(i, n0), surface(j, n1), surface(i, n1)], [n0, n1, n1], blanks);
      }
    }

  for (const [corner, vertex] of shape.verts.entries()) {
    const axis = normalize(vertex);
    const around = shape.faces.filter((face) => face.verts.includes(corner));
    const first = around[0]!.normal;
    const ref = normalize(sub(first, scale(axis, dot(first, axis))));
    const side = cross(axis, ref);
    const angle = (n: Vec) => pseudoAngle(dot(n, ref), dot(n, side));
    around.sort((p, q) => angle(p.normal) - angle(q.normal));
    let sum: Vec = [0, 0, 0];
    for (const face of around) sum = add(sum, face.normal);
    const middle = normalize(sum);
    const at = (n: Vec) => surface(corner, n);
    for (const [k, face] of around.entries()) {
      const ns = arc(face.normal, around[(k + 1) % around.length]!.normal);
      for (let t = 0; t < segments; t += 1) {
        const n0 = ns[t]!;
        const n1 = ns[t + 1]!;
        const m0 = normalize(add(middle, n0));
        const m1 = normalize(add(middle, n1));
        triangle([at(middle), at(m0), at(m1)], [middle, m0, m1], blanks);
        triangle([at(m0), at(n0), at(n1)], [m0, n0, n1], blanks);
        triangle([at(m0), at(n1), at(m1)], [m0, n1, m1], blanks);
      }
    }
  }

  return {
    count: positions.length / 3,
    normals: Float32Array.from(normals),
    positions: Float32Array.from(positions),
    uvs: Float32Array.from(uvs),
  };
}
