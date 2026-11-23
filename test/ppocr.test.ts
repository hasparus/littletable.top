import { describe, expect, it } from "vitest";

import {
  boxesFromMap,
  convexHull,
  ctcDecode,
  flipped,
  frameOf,
  minAreaRect,
  orderQuad,
  type Point,
  type Quad,
  sampleFrame,
  sortReading,
} from "../client/src/ppocr";

// How the pipeline's geometry goes wrong, each of which loses or misplaces
// a word: the hull keeps inner or repeated points; the rectangle around a
// tilted label comes out upright (and the crop reads two labels at once);
// corners come in an order that reads the label backwards; the detector's
// map turns specks into words or merges what is apart; a tall label is
// read sideways; the crop is not sampled along the label; CTC repeats a
// letter, keeps blanks or puts a word where its letters were not.

const rotate = ([x, y]: Point, degrees: number, [cx, cy]: Point): Point => {
  const r = (degrees * Math.PI) / 180;
  const [dx, dy] = [x - cx, y - cy];
  return [cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r)];
};

describe("the hull and the rectangle around a region", () => {
  it("keeps only the outside corners", () => {
    const hull = convexHull([
      [0, 0],
      [4, 0],
      [4, 0],
      [2, 1],
      [4, 3],
      [0, 3],
      [2, 0],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(
      expect.arrayContaining([
        [0, 0],
        [4, 0],
        [4, 3],
        [0, 3],
      ]),
    );
  });

  it("finds a tilted label's own rectangle, not an upright one around it", () => {
    const corners: Point[] = [
      [0, 0],
      [100, 0],
      [100, 20],
      [0, 20],
    ].map((point) => rotate(point as Point, 30, [50, 10]));
    const rect = minAreaRect(convexHull(corners))!;
    expect([rect.w, rect.h].toSorted((a, b) => a - b)).toEqual([
      expect.closeTo(20, 6),
      expect.closeTo(100, 6),
    ]);
    expect(rect.area).toBeCloseTo(2000, 3);
  });

  it("orders corners from the top left, clockwise", () => {
    const quad = orderQuad([
      [10, 20],
      [90, 5],
      [0, 0],
      [100, 25],
    ]);
    expect(quad).toEqual([
      [0, 0],
      [90, 5],
      [100, 25],
      [10, 20],
    ]);
  });
});

describe("the detector's probability map", () => {
  const W = 128;
  const H = 96;
  const options = { boxThresh: 0.5, detThresh: 0.3, minSide: 2, unclip: 1.6 };
  const map = (inside: (x: number, y: number) => boolean) => {
    const prob = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) prob[y * W + x] = 0.9;
    return prob;
  };

  it("gives a tilted bar a quad tilted with it, grown past the bar", () => {
    // A bar 80 × 10 around (64, 48), tilted 30°.
    const prob = map((x, y) => {
      const [u, v] = rotate([x + 0.5, y + 0.5], -30, [64, 48]);
      return Math.abs(u - 64) <= 40 && Math.abs(v - 48) <= 5;
    });
    const [box, ...more] = boxesFromMap(prob, { H, W }, options);
    expect(more).toEqual([]);
    const [tl, tr, , bl] = box!.quad;
    const angle = (Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180) / Math.PI;
    expect(angle).toBeCloseTo(30, 0);
    expect(Math.hypot(tr[0] - tl[0], tr[1] - tl[1])).toBeGreaterThan(80);
    expect(Math.hypot(bl[0] - tl[0], bl[1] - tl[1])).toBeGreaterThan(10);
  });

  it("keeps two regions apart, and drops specks and faint regions", () => {
    const prob = map(
      (x, y) =>
        (y >= 10 && y < 20 && ((x >= 10 && x < 50) || (x >= 60 && x < 100))) ||
        (x === 5 && y === 80),
    );
    for (let x = 20; x < 60; x++) for (let y = 60; y < 70; y++) prob[y * W + x] = 0.4;
    expect(boxesFromMap(prob, { H, W }, options)).toHaveLength(2);
  });
});

describe("reading a box", () => {
  const square = (x: number, y: number, w: number, h: number): Quad => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];

  it("reads a wide box along its width and a tall one turned a quarter", () => {
    expect(frameOf(square(0, 0, 100, 20))).toEqual({
      frame: { o: [0, 0], u: [100, 0], v: [0, 20] },
      tall: false,
    });
    // A label running down the page, read from its top: along it, the
    // letters lie towards the left.
    expect(frameOf(square(0, 0, 20, 100))).toEqual({
      frame: { o: [20, 0], u: [0, 100], v: [-20, 0] },
      tall: true,
    });
  });

  it("turns a frame upside down around the same box", () => {
    expect(flipped({ o: [0, 0], u: [100, 0], v: [0, 20] })).toEqual({
      o: [100, 20],
      u: [-100, -0],
      v: [-0, -20],
    });
  });

  it("samples a tilted stripe level", () => {
    // A dark stripe through the middle of a white image, tilted 30°.
    const width = 200;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [, v] = rotate([x + 0.5, y + 0.5], -30, [100, 100]);
        if (Math.abs(v - 100) <= 4) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    }
    const [o, u] = [rotate([40, 88], 30, [100, 100]), rotate([160, 88], 30, [100, 100])];
    const [, , , v] = [0, 0, 0, rotate([40, 112], 30, [100, 100])];
    const frame = {
      o,
      u: [u[0] - o[0], u[1] - o[1]] as Point,
      v: [v[0] - o[0], v[1] - o[1]] as Point,
    };
    const tensor = sampleFrame({ data, height, width }, frame, { H: 24, W: 120 });
    // Blue channel, row by row: dark in the middle rows only, all along.
    const row = (y: number) => tensor.subarray(y * 120 + 5, y * 120 + 115);
    expect(Math.max(...row(12))).toBeLessThan(-0.5);
    expect(Math.min(...row(1))).toBeGreaterThan(0.5);
    expect(Math.min(...row(22))).toBeGreaterThan(0.5);
  });

  it("reads top to bottom, then left to right on a line", () => {
    const boxes = [square(300, 105, 50, 20), square(10, 300, 50, 20), square(10, 100, 50, 20)];
    expect(sortReading(boxes.map((quad) => ({ quad }))).map(({ quad }) => quad[0])).toEqual([
      [10, 100],
      [300, 105],
      [10, 300],
    ]);
  });
});

describe("CTC decoding", () => {
  const chars = ["", "a", "b", " "];
  // One step per row, a probability per class.
  const steps = (...best: number[]) => {
    const data = new Float32Array(best.length * chars.length);
    for (const [t, c] of best.entries()) {
      data.fill(0.01, t * chars.length, (t + 1) * chars.length);
      data[t * chars.length + c] = 0.9;
    }
    return ctcDecode(data, best.length, chars.length, chars);
  };

  it("drops blanks and repeats, but keeps a letter written twice across a blank", () => {
    expect(steps(1, 1, 0, 1, 2, 2, 0).text).toBe("aab");
  });

  it("splits words at spaces, each where its letters fired", () => {
    const decoded = steps(1, 2, 0, 0, 3, 0, 0, 2, 1, 0);
    expect(decoded.words.map(({ text }) => text)).toEqual(["ab", "ba"]);
    const [first, second] = decoded.words;
    expect(first!.a).toBeCloseTo(0, 5);
    expect(first!.b).toBeLessThan(0.3);
    expect(second!.a).toBeGreaterThan(0.6);
    expect(second!.b).toBeLessThanOrEqual(1);
    expect(decoded.conf).toBeCloseTo(0.9, 5);
  });
});
