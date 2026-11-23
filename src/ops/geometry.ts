import {
  b64Vecs,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDrawShape,
  type TLGeoShape,
  type TLLineShape,
  type TLNoteShape,
  type TLShape,
  type TLTextShape,
} from "@tldraw/tlschema";

import type { Doc } from "./doc";

import { type FontFamily } from "./text/measure";
import { NOTE_SIDE, type SizeStyle, textShapeSize } from "./text/sizing";

// Where shapes are, from their records alone: each default shape's box in
// its own space, its transform to the page (position and rotation, through
// frames and groups), and the page-axis box around it. Text shapes are
// measured (text/); arrows follow their bindings to the shapes they join.

export type Box = { h: number; w: number; x: number; y: number };
export type Vec = { x: number; y: number };

// [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const apply = (m: Matrix, { x, y }: Vec): Vec => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

const local = (shape: TLShape): Matrix => {
  const cos = Math.cos(shape.rotation);
  const sin = Math.sin(shape.rotation);
  return [cos, sin, -sin, cos, shape.x, shape.y];
};

export function pageTransform(doc: Doc, shape: TLShape): Matrix {
  const parent = doc.shape(shape.parentId);
  return multiply(parent === undefined ? IDENTITY : pageTransform(doc, parent), local(shape));
}

/** Page coordinates into a shape's own space. */
export const pageToLocal = (doc: Doc, shape: TLShape): Matrix => invert(pageTransform(doc, shape));

/** The transform a point in page coordinates needs to land in a parent's space. */
export function toParentSpace(doc: Doc, parentId: string): Matrix {
  const parent = doc.shape(parentId);
  return parent === undefined ? IDENTITY : invert(pageTransform(doc, parent));
}

function boxOf(points: Vec[]): Box {
  if (points.length === 0) return { h: 0, w: 0, x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { h: maxY - minY, w: maxX - minX, x: minX, y: minY };
}

const corners = ({ h, w, x, y }: Box): Vec[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const props = (shape: TLShape) => shape.props as Record<string, unknown>;

// NOTE: records are never changed in place, so a box that depends on its
// record alone (not on children or bindings) is worked out once per record.
// Without this a batch of n ops on a board of m shapes measures m texts n times.
const ownBoxes = new WeakMap<TLShape, Box>();
const DEPENDS_ON_OTHERS = new Set(["arrow", "group"]);

/** The shape's box in its own space, before its own position and rotation. */
export function localBounds(doc: Doc, shape: TLShape): Box {
  if (DEPENDS_ON_OTHERS.has(shape.type)) return computeLocalBounds(doc, shape);
  let box = ownBoxes.get(shape);
  if (box === undefined) {
    box = computeLocalBounds(doc, shape);
    ownBoxes.set(shape, box);
  }
  return box;
}

function computeLocalBounds(doc: Doc, shape: TLShape): Box {
  const scale = (props(shape).scale as number | undefined) ?? 1;
  switch (shape.type) {
    case "arrow": {
      return boxOf(arrowPath(doc, shape as TLArrowShape));
    }
    case "draw":
    case "highlight": {
      const points = (shape as TLDrawShape).props.segments.flatMap((segment) =>
        b64Vecs.decodePoints(segment.path),
      );
      return boxOf(points.map(({ x, y }) => ({ x: x * scale, y: y * scale })));
    }
    case "geo": {
      const { growY, h, w } = (shape as TLGeoShape).props;
      return { h: h + growY, w, x: 0, y: 0 };
    }
    case "group": {
      const boxes = doc
        .children(shape.id)
        .flatMap((child) => corners(localBounds(doc, child)).map((p) => apply(local(child), p)));
      return boxOf(boxes);
    }
    case "line": {
      return boxOf(Object.values((shape as TLLineShape).props.points));
    }
    case "note": {
      const { growY } = (shape as TLNoteShape).props;
      return { h: (NOTE_SIDE + growY) * scale, w: NOTE_SIDE * scale, x: 0, y: 0 };
    }
    case "text": {
      const { autoSize, font, richText, size, w } = (shape as TLTextShape).props;
      const measured = textShapeSize(richText, {
        autoSize,
        font: font as FontFamily,
        size: size as SizeStyle,
        w,
      });
      return { h: measured.h * scale, w: measured.w * scale, x: 0, y: 0 };
    }
    default: {
      const { h, w } = props(shape) as { h?: number; w?: number };
      return { h: h ?? 1, w: w ?? 1, x: 0, y: 0 };
    }
  }
}

export function pageBounds(doc: Doc, shape: TLShape): Box {
  const transform = pageTransform(doc, shape);
  return boxOf(corners(localBounds(doc, shape)).map((p) => apply(transform, p)));
}

export const center = ({ h, w, x, y }: Box): Vec => ({ x: x + w / 2, y: y + h / 2 });

export function intersects(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    b.x < a.x + a.w + margin &&
    a.y < b.y + b.h + margin &&
    b.y < a.y + a.h + margin
  );
}

export function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  return boxOf(boxes.flatMap(corners));
}

// Where a segment from inside a box leaves it: the point on the box's edge
// on the way from its centre to `toward`.
function exitPoint(box: Box, toward: Vec): Vec {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The page point an arrow's end sits at: its bound shape's anchor, or its own. */
export function terminalOnPage(
  doc: Doc,
  arrow: TLArrowShape,
  terminal: "end" | "start",
  binding: TLArrowBinding | undefined,
): { bound: Box | null; point: Vec } {
  const target = binding === undefined ? undefined : doc.shape(binding.toId);
  if (binding !== undefined && target !== undefined) {
    const box = pageBounds(doc, target);
    const { x, y } = binding.props.normalizedAnchor;
    return { bound: box, point: { x: box.x + box.w * x, y: box.y + box.h * y } };
  }
  return { bound: null, point: apply(pageTransform(doc, arrow), arrow.props[terminal]) };
}

const sq = (p: Vec) => p.x * p.x + p.y * p.y;
const wrap = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

const inside = (box: Box, { x, y }: Vec) =>
  x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;

/**
 * The course of an arrow between two anchors in one space: a straight line,
 * or with a bend the arc through the point `bend` off the chord's middle (on
 * the side tldraw's curved arrow puts it), sampled. The parts inside the
 * boxes it joins are dropped, as tldraw stops an arrow at their outline.
 */
export function arcCourse(a: Vec, b: Vec, bend: number, joined: Box[] = [], steps = 24): Vec[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  let points: Vec[];
  if (bend === 0 || length === 0) {
    points = Array.from({ length: steps + 1 }, (_, step) => ({
      x: a.x + ((b.x - a.x) * step) / steps,
      y: a.y + ((b.y - a.y) * step) / steps,
    }));
  } else {
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    // NOTE: tldraw: middle = med + per(u) * -bend, with per(u) = (u.y, -u.x).
    const m = { x: (a.x + b.x) / 2 - u.y * bend, y: (a.y + b.y) / 2 + u.x * bend };
    const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
    const c = {
      x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d,
      y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d,
    };
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    const angle = (p: Vec) => Math.atan2(p.y - c.y, p.x - c.x);
    const start = angle(a);
    let sweep = angle(b) - start;
    let toMiddle = angle(m) - start;
    sweep = wrap(sweep);
    toMiddle = wrap(toMiddle);
    if (toMiddle > sweep) sweep -= 2 * Math.PI;
    points = Array.from({ length: steps + 1 }, (_, step) => {
      const t = start + (sweep * step) / steps;
      return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
    });
  }
  return points.filter((point) => !joined.some((box) => inside(box, point)));
}

/** An arrow's visible course in its own space, clipped to the shapes it joins. */
export function arrowPath(doc: Doc, arrow: TLArrowShape): Vec[] {
  const bindings = doc.bindingsOf(arrow.id).filter((binding) => binding.fromId === arrow.id);
  const find = (terminal: "end" | "start") =>
    bindings.find((binding) => binding.props.terminal === terminal);
  const start = terminalOnPage(doc, arrow, "start", find("start"));
  const end = terminalOnPage(doc, arrow, "end", find("end"));
  const joined = [start.bound, end.bound].filter((box) => box !== null);
  const course = arcCourse(start.point, end.point, arrow.props.bend, joined);
  const ends = [
    start.bound === null ? start.point : exitPoint(start.bound, course[0] ?? end.point),
    end.bound === null ? end.point : exitPoint(end.bound, course.at(-1) ?? start.point),
  ];
  const toLocal = invert(pageTransform(doc, arrow));
  return [ends[0]!, ...course, ends[1]!].map((point) => apply(toLocal, point));
}
