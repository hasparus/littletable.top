import type { TLPageId, TLShape } from "@tldraw/tlschema";

import type { Doc } from "./doc";

import { type Box, intersects, pageBounds } from "./geometry";

// Where a new or moved shape goes when an op names a neighbour rather than
// a point: beside it on the asked side, aligned as asked, then nudged to the
// nearest spot that keeps CLEARANCE from every other shape. Lines, strokes
// and arrows are not obstacles; frames hold shapes and are not either.

export const CLEARANCE = 20;
export const DEFAULT_GAP = 40;
const SEARCH = 2_000;

export type Relation = "above" | "below" | "centered_on" | "inside" | "left_of" | "right_of";
export type Align = "center" | "end" | "start";

const NOT_OBSTACLES = new Set(["arrow", "draw", "frame", "group", "highlight", "line"]);

export function obstacles(doc: Doc, pageId: TLPageId, exclude: Set<string>): Box[] {
  return doc
    .shapesOnPage(pageId)
    .filter((shape) => !exclude.has(shape.id) && !NOT_OBSTACLES.has(shape.type))
    .map((shape) => pageBounds(doc, shape));
}

const along = (start: number, length: number, size: number, align: Align) =>
  align === "start" ? start : align === "end" ? start + length - size : start + (length - size) / 2;

export function idealSpot(
  target: Box,
  size: { h: number; w: number },
  {
    align = "center",
    gap = DEFAULT_GAP,
    relation,
  }: { align?: Align; gap?: number; relation: Relation },
): { x: number; y: number } {
  switch (relation) {
    case "right_of":
      return { x: target.x + target.w + gap, y: along(target.y, target.h, size.h, align) };
    case "left_of":
      return { x: target.x - gap - size.w, y: along(target.y, target.h, size.h, align) };
    case "below":
      return { x: along(target.x, target.w, size.w, align), y: target.y + target.h + gap };
    case "above":
      return { x: along(target.x, target.w, size.w, align), y: target.y - gap - size.h };
    case "inside":
    case "centered_on":
      return {
        x: target.x + (target.w - size.w) / 2,
        y: target.y + (target.h - size.h) / 2,
      };
  }
}

// The candidate spots are the ideal one and every spot flush against a
// nearby obstacle's edge (plus clearance), on the asked side of the target;
// the free one nearest the ideal wins.
export function clearSpot(
  ideal: { x: number; y: number },
  size: { h: number; w: number },
  blockers: Box[],
  relation: Relation,
  target: Box | null,
): { x: number; y: number } {
  const free = (x: number, y: number) =>
    !blockers.some((box) => intersects({ h: size.h, w: size.w, x, y }, box, CLEARANCE - 0.001));
  if (free(ideal.x, ideal.y)) return ideal;
  const near = blockers.filter(
    (box) =>
      box.x < ideal.x + size.w + SEARCH &&
      box.x + box.w > ideal.x - SEARCH &&
      box.y < ideal.y + size.h + SEARCH &&
      box.y + box.h > ideal.y - SEARCH,
  );
  const xs = new Set([ideal.x]);
  const ys = new Set([ideal.y]);
  for (const box of near) {
    xs.add(box.x + box.w + CLEARANCE);
    xs.add(box.x - CLEARANCE - size.w);
    ys.add(box.y + box.h + CLEARANCE);
    ys.add(box.y - CLEARANCE - size.h);
  }
  const onSide = (x: number, y: number) => {
    if (target === null) return true;
    switch (relation) {
      case "right_of":
        return x >= target.x + target.w;
      case "left_of":
        return x + size.w <= target.x;
      case "below":
        return y >= target.y + target.h;
      case "above":
        return y + size.h <= target.y;
      default:
        return true;
    }
  };
  // NOTE: sliding further along the asked direction keeps "right of" reading
  // as right of; a sideways step costs twice as much.
  const sideways = relation === "above" || relation === "below" ? { x: 2, y: 1 } : { x: 1, y: 2 };
  let best: { distance: number; x: number; y: number } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const distance = Math.hypot((x - ideal.x) * sideways.x, (y - ideal.y) * sideways.y);
      if (best !== null && distance >= best.distance) continue;
      if (onSide(x, y) && free(x, y)) best = { distance, x, y };
    }
  }
  return best ?? ideal;
}

export function excludeFor(doc: Doc, shapes: TLShape[]): Set<string> {
  const out = new Set<string>();
  for (const shape of shapes) {
    out.add(shape.id);
    for (const child of doc.descendants(shape.id)) out.add(child.id);
  }
  return out;
}
