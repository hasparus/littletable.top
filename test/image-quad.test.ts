import { describe, expect, it } from "vitest";

import type { Point } from "../client/src/search-index";

import { type Affine, boundsOf, type Box, imageQuadToPage } from "../client/src/image-quad";

// What can go wrong when a line read off an image is shown on the board:
// - scale or offset forgotten: "moved and scaled"
// - rotation applied about the wrong point or the wrong way: "rotated"
// - a flip ignored, or the crop read in the unflipped image (tldraw 5.6
//   flips first): "flipped", "crop and flip"
// - text the crop hides is shown, or text across its edge spills out:
//   "cropped"
// - a parent frame's rotation ignored: "inside a rotated frame"
// - a slanted line flattened into a box: "a slanted line"

// translate(x, y) · rotate(r): a shape with no parent.
function placed(x: number, y: number, rotation: number): Affine {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { a: cos, b: sin, c: -sin, d: cos, e: x, f: y };
}

const compose = (m: Affine, n: Affine): Affine => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

const AT_ORIGIN = placed(0, 0, 0);
const SOURCE = { h: 1000, w: 2000 };

const box = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

function expectNear(got: Point[] | null, want: Point[]): void {
  expect(got).not.toBeNull();
  expect(got).toHaveLength(want.length);
  got!.forEach((point, index) => {
    expect(point.x).toBeCloseTo(want[index]!.x, 9);
    expect(point.y).toBeCloseTo(want[index]!.y, 9);
  });
}

function expectBounds(got: Point[] | null, want: Box): void {
  expect(got).not.toBeNull();
  const bounds = boundsOf(got!);
  for (const key of ["x", "y", "w", "h"] as const) expect(bounds[key]).toBeCloseTo(want[key], 9);
}

describe("imageQuadToPage", () => {
  it("maps pixels one to one for an image at the origin at its natural size", () => {
    const got = imageQuadToPage(box(100, 50, 300, 90), SOURCE, { h: 1000, w: 2000 }, AT_ORIGIN);
    expectNear(got, box(100, 50, 300, 90));
  });

  it("follows an image moved and scaled to half its size", () => {
    const got = imageQuadToPage(
      box(100, 50, 300, 90),
      SOURCE,
      { h: 500, w: 1000 },
      placed(500, 200, 0),
    );
    expectNear(got, box(550, 225, 650, 245));
  });

  it("follows an image rotated a quarter turn about its origin", () => {
    const got = imageQuadToPage(
      box(100, 50, 300, 90),
      SOURCE,
      { h: 1000, w: 2000 },
      placed(1000, 0, Math.PI / 2),
    );
    expectNear(got, [
      { x: 950, y: 100 },
      { x: 950, y: 300 },
      { x: 910, y: 300 },
      { x: 910, y: 100 },
    ]);
    expectBounds(got, { h: 200, w: 40, x: 910, y: 100 });
  });

  it("mirrors a line inside a flipped image", () => {
    const got = imageQuadToPage(
      box(100, 50, 300, 90),
      SOURCE,
      { flipX: true, h: 1000, w: 2000 },
      AT_ORIGIN,
    );
    expectNear(got, [
      { x: 1900, y: 50 },
      { x: 1700, y: 50 },
      { x: 1700, y: 90 },
      { x: 1900, y: 90 },
    ]);
  });

  it("drops a line the crop hides and clips one across its edge", () => {
    const fit = {
      crop: { bottomRight: { x: 1, y: 1 }, topLeft: { x: 0.5, y: 0 } },
      h: 1000,
      w: 1000,
    };
    expectNear(
      imageQuadToPage(box(1200, 100, 1400, 200), SOURCE, fit, AT_ORIGIN),
      box(200, 100, 400, 200),
    );
    expect(imageQuadToPage(box(100, 100, 300, 200), SOURCE, fit, AT_ORIGIN)).toBeNull();
    expectNear(
      imageQuadToPage(box(900, 100, 1100, 200), SOURCE, fit, AT_ORIGIN),
      box(0, 100, 100, 200),
    );
  });

  it("reads the crop in the flipped image", () => {
    // Flipped, the source's right half shows on the left, so a crop to the
    // left half shows the source's x from 1000 to 2000.
    const fit = {
      crop: { bottomRight: { x: 0.5, y: 1 }, topLeft: { x: 0, y: 0 } },
      flipX: true,
      h: 1000,
      w: 1000,
    };
    const got = imageQuadToPage(box(1200, 100, 1400, 200), SOURCE, fit, AT_ORIGIN);
    expectBounds(got, { h: 100, w: 200, x: 600, y: 100 });
  });

  it("follows an image inside a rotated, moved frame", () => {
    const transform = compose(placed(100, 100, Math.PI), placed(10, 20, 0));
    const got = imageQuadToPage(box(0, 0, 200, 100), SOURCE, { h: 1000, w: 2000 }, transform);
    expectBounds(got, { h: 100, w: 200, x: -110, y: -20 });
  });

  it("keeps the shape of a slanted line, a map label at 45°", () => {
    const slanted = [
      { x: 0, y: 100 },
      { x: 100, y: 0 },
      { x: 110, y: 10 },
      { x: 10, y: 110 },
    ];
    const got = imageQuadToPage(slanted, SOURCE, { h: 500, w: 1000 }, AT_ORIGIN);
    expectNear(
      got,
      slanted.map((point) => ({ x: point.x / 2, y: point.y / 2 })),
    );
  });
});
