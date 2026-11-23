import { arcCourse, type Box, intersects, type Vec } from "./geometry";

// How a new arrow runs: straight when nothing is in the way, else bent just
// enough (either side, smallest bend first) that neither its course nor
// its label crosses another shape. tldraw draws the bend as given.

const BENDS = [0, 40, -40, 80, -80, 120, -120, 180, -180, 260, -260, 360, -360];
const MARGIN = 6;

// Liang–Barsky: whether the segment p→q passes through the box.
export function segmentHitsBox(p: Vec, q: Vec, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges: [number, number][] = [
    [-dx, p.x - box.x],
    [dx, box.x + box.w - p.x],
    [-dy, p.y - box.y],
    [dy, box.y + box.h - p.y],
  ];
  for (const [step, room] of edges) {
    if (step === 0) {
      if (room < 0) return false;
      continue;
    }
    const t = room / step;
    if (step < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

const grow = (box: Box, by: number): Box => ({
  h: box.h + by * 2,
  w: box.w + by * 2,
  x: box.x - by,
  y: box.y - by,
});

export function routeArrow({
  blockers,
  from,
  joined,
  label,
  to,
}: {
  blockers: Box[];
  from: Vec;
  joined: Box[];
  label: { h: number; w: number } | null;
  to: Vec;
}): { bend: number; crossed: number } {
  const around = blockers.map((box) => grow(box, MARGIN));
  const crossings = (bend: number) => {
    const course = arcCourse(from, to, bend, joined);
    const hit = new Set<number>();
    // NOTE: only shapes under the course's own box can be crossed; on a
    // large board that is a handful out of thousands.
    const xs = course.map((point) => point.x);
    const ys = course.map((point) => point.y);
    const reach = label === null ? 0 : Math.max(label.w, label.h);
    const span = {
      h: Math.max(...ys) - Math.min(...ys) + reach * 2,
      w: Math.max(...xs) - Math.min(...xs) + reach * 2,
      x: Math.min(...xs) - reach,
      y: Math.min(...ys) - reach,
    };
    const near = around
      .map((box, which) => ({ box, which }))
      .filter(({ box }) => intersects(span, box));
    for (let index = 1; index < course.length; index++) {
      for (const { box, which } of near) {
        if (segmentHitsBox(course[index - 1]!, course[index]!, box)) hit.add(which);
      }
    }
    if (label !== null && course.length > 0) {
      const middle = course[Math.floor(course.length / 2)]!;
      const box = { h: label.h, w: label.w, x: middle.x - label.w / 2, y: middle.y - label.h / 2 };
      for (const { box: blocker, which } of near) {
        if (intersects(box, blocker)) hit.add(which);
      }
    }
    return hit.size;
  };
  const straight = crossings(0);
  if (straight === 0) return { bend: 0, crossed: 0 };
  for (const bend of BENDS.slice(1)) {
    if (crossings(bend) === 0) return { bend, crossed: 0 };
  }
  return { bend: 0, crossed: straight };
}
