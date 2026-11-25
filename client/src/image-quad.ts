import type { Point } from "./search-index";

/**
 * A 2D affine matrix as tldraw's Mat holds it: x' = a·x + c·y + e,
 * y' = b·x + d·y + f. editor.getShapePageTransform(shape) is one.
 */
export type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

export type Crop = { bottomRight: Point; topLeft: Point };

export type ImageFit = {
  crop?: Crop | null;
  flipX?: boolean;
  flipY?: boolean;
  h: number;
  w: number;
};

export type Size = { h: number; w: number };

/**
 * Maps a polygon in the SOURCE image's pixels (a line read off it) to page
 * coordinates for the image shape as it lies now: moved, resized, rotated,
 * flipped, cropped, inside rotated or scaled frames and groups.
 *
 * NOTE: tldraw 5.6 draws an image by mirroring the whole source inside its
 * uncropped box first and then shifting it by the crop, so `crop` is
 * measured in the flipped image (onResize flips the crop with the shape):
 *   u, v     source pixel / source size                      (0..1)
 *   u', v'   flipX ? 1 - u : u, flipY ? 1 - v : v            (as displayed)
 *   x, y     (u' - crop.x) / crop width · w, likewise for y  (shape space)
 *   page     transform · (x, y)
 * The part outside the crop is clipped off; a polygon wholly outside it is
 * not visible, and the answer is null.
 */
export function imageQuadToPage(
  quad: readonly Point[],
  source: Size,
  fit: ImageFit,
  transform: Affine,
): Point[] | null {
  const tl = fit.crop?.topLeft ?? { x: 0, y: 0 };
  const br = fit.crop?.bottomRight ?? { x: 1, y: 1 };
  const shown = quad.map(({ x, y }) => {
    const u = x / source.w;
    const v = y / source.h;
    return { x: fit.flipX === true ? 1 - u : u, y: fit.flipY === true ? 1 - v : v };
  });
  const visible = clipToRect(shown, tl, br);
  if (visible.length < 3 || area(visible) < 1e-12) return null;
  const sx = fit.w / (br.x - tl.x);
  const sy = fit.h / (br.y - tl.y);
  const { a, b, c, d, e, f } = transform;
  return visible.map(({ x, y }) => {
    const lx = (x - tl.x) * sx;
    const ly = (y - tl.y) * sy;
    return { x: a * lx + c * ly + e, y: b * lx + d * ly + f };
  });
}

export type Box = { h: number; w: number; x: number; y: number };

export function boundsOf(polygon: readonly Point[]): Box {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { h: Math.max(...ys) - y, w: Math.max(...xs) - x, x, y };
}

type Edge = { cut: (from: Point, to: Point) => Point; inside: (point: Point) => boolean };

const lerp = (from: Point, to: Point, t: number): Point => ({
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
});

function clipToRect(polygon: Point[], min: Point, max: Point): Point[] {
  const edges: Edge[] = [
    { cut: (p, q) => lerp(p, q, (min.x - p.x) / (q.x - p.x)), inside: (p) => p.x >= min.x },
    { cut: (p, q) => lerp(p, q, (max.x - p.x) / (q.x - p.x)), inside: (p) => p.x <= max.x },
    { cut: (p, q) => lerp(p, q, (min.y - p.y) / (q.y - p.y)), inside: (p) => p.y >= min.y },
    { cut: (p, q) => lerp(p, q, (max.y - p.y) / (q.y - p.y)), inside: (p) => p.y <= max.y },
  ];
  let out = polygon;
  for (const { cut, inside } of edges) {
    const input = out;
    out = [];
    let previous = input.at(-1)!;
    for (const current of input) {
      if (inside(current)) {
        if (!inside(previous)) out.push(cut(previous, current));
        out.push(current);
      } else if (inside(previous)) out.push(cut(previous, current));
      previous = current;
    }
    if (out.length === 0) break;
  }
  return out;
}

function area(polygon: readonly Point[]): number {
  let sum = 0;
  let p = polygon.at(-1)!;
  for (const q of polygon) {
    sum += p.x * q.y - q.x * p.y;
    p = q;
  }
  return Math.abs(sum) / 2;
}
