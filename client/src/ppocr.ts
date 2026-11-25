export type Point = [number, number];
/** Corners clockwise from the top left of the text as it reads. */
export type Quad = [Point, Point, Point, Point];

export type Pixels = { data: Uint8ClampedArray; height: number; width: number };

export type PaddleWord = { conf: number; line: number; quad: Quad; text: string };

export type PipelineOptions = {
  /** A region is kept when its mean probability is above this. */
  boxThresh: number;
  /** The detector's input, long side, in pixels (a multiple of 32). */
  detMaxSide: number;
  /** A pixel belongs to text above this probability. */
  detThresh: number;
  /** A line read with less confidence is read upside down too. */
  flipBelow: number;
  /** Lines read with less mean confidence are dropped. */
  minConf: number;
  /** A region narrower than this, in detector pixels, is dropped. */
  minSide: number;
  recHeight: number;
  recMaxWidth: number;
  /** How far a region grows back out (DB shrinks text regions in training). */
  unclip: number;
};

export const DEFAULT_OPTIONS: PipelineOptions = {
  boxThresh: 0.5,
  detMaxSide: 960,
  detThresh: 0.3,
  flipBelow: 0.9,
  minConf: 0.5,
  minSide: 4,
  recHeight: 48,
  recMaxWidth: 1600,
  unclip: 1.6,
};

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const neg = (a: Point): Point => [-a[0], -a[1]];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Where to read a crop: its origin, `u` along the text as it reads, `v`
 * down its letters.
 */
export type Frame = { o: Point; u: Point; v: Point };

type Rgb = [number, number, number];

function bilinear(img: Pixels, fx: number, fy: number, out: Rgb): void {
  const { data, height, width } = img;
  const x = Math.min(width - 1, Math.max(0, fx));
  const y = Math.min(height - 1, Math.max(0, fy));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const ax = x - x0;
  const ay = y - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  for (let channel = 0; channel < 3; channel++) {
    out[channel] =
      data[i00 + channel]! * w00 +
      data[i10 + channel]! * w10 +
      data[i01 + channel]! * w01 +
      data[i11 + channel]! * w11;
  }
}

/**
 * The image at W × H as a normalised CHW tensor in BGR order, which
 * PP-OCR was trained on: box-averaged when shrinking by 2× or more,
 * bilinear otherwise.
 */
export function resizeToChw(img: Pixels, size: { H: number; W: number }): Float32Array {
  const { H, W } = size;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * W * H);
  const sx = img.width / W;
  const sy = img.height / H;
  const bx = Math.max(1, Math.floor(sx));
  const by = Math.max(1, Math.floor(sy));
  const n = W * H;
  const rgb: Rgb = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (bx > 1 || by > 1) {
        const x0 = Math.floor(x * sx);
        const y0 = Math.floor(y * sy);
        let count = 0;
        rgb.fill(0);
        for (let yy = y0; yy < Math.min(img.height, y0 + by); yy++) {
          for (let xx = x0; xx < Math.min(img.width, x0 + bx); xx++) {
            const at = (yy * img.width + xx) * 4;
            rgb[0] += img.data[at]!;
            rgb[1] += img.data[at + 1]!;
            rgb[2] += img.data[at + 2]!;
            count++;
          }
        }
        for (let channel = 0; channel < 3; channel++) rgb[channel]! /= count;
      } else bilinear(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, rgb);
      const at = y * W + x;
      out[at] = (rgb[2] / 255 - mean[0]!) / std[0]!;
      out[n + at] = (rgb[1] / 255 - mean[1]!) / std[1]!;
      out[2 * n + at] = (rgb[0] / 255 - mean[2]!) / std[2]!;
    }
  }
  return out;
}

/**
 * The rotated rectangle `frame` sampled upright into a W × H recogniser
 * input ((x / 255 − 0.5) / 0.5, BGR), supersampled when it shrinks.
 */
export function sampleFrame(
  img: Pixels,
  frame: Frame,
  size: { H: number; W: number },
): Float32Array {
  const { H, W } = size;
  const out = new Float32Array(3 * W * H);
  const n = W * H;
  const stepU = Math.hypot(frame.u[0], frame.u[1]) / W;
  const stepV = Math.hypot(frame.v[0], frame.v[1]) / H;
  const ss = Math.max(1, Math.min(4, Math.round(Math.max(stepU, stepV))));
  const rgb: Rgb = [0, 0, 0];
  const sum: Rgb = [0, 0, 0];
  const k = 1 / (ss * ss * 127.5);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      sum.fill(0);
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const a = (x + (i + 0.5) / ss) / W;
          const c = (y + (j + 0.5) / ss) / H;
          const fx = frame.o[0] + frame.u[0] * a + frame.v[0] * c - 0.5;
          const fy = frame.o[1] + frame.u[1] * a + frame.v[1] * c - 0.5;
          bilinear(img, fx, fy, rgb);
          sum[0] += rgb[0];
          sum[1] += rgb[1];
          sum[2] += rgb[2];
        }
      }
      const at = y * W + x;
      out[at] = sum[2] * k - 1;
      out[n + at] = sum[1] * k - 1;
      out[2 * n + at] = sum[0] * k - 1;
    }
  }
  return out;
}

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function convexHull(points: readonly Point[]): Point[] {
  const sorted = points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export type Rect = {
  area: number;
  h: number;
  maxU: number;
  maxV: number;
  minU: number;
  minV: number;
  ux: number;
  uy: number;
  w: number;
};

/**
 * The smallest rectangle around a convex polygon: one of its sides lies
 * along an edge of the polygon.
 */
export function minAreaRect(hull: readonly Point[]): Rect | null {
  if (hull.length < 3) return null;
  let best: Rect | null = null;
  for (let at = 0; at < hull.length; at++) {
    const a = hull[at]!;
    const b = hull[(at + 1) % hull.length]!;
    const length = dist(a, b);
    if (length === 0) continue;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (best === null || area < best.area) {
      best = { area, h: maxV - minV, maxU, maxV, minU, minV, ux, uy, w: maxU - minU };
    }
  }
  return best;
}

export function rectCorners(rect: Rect, grow: number): Quad {
  const corner = (u: number, v: number): Point => [
    u * rect.ux - v * rect.uy,
    u * rect.uy + v * rect.ux,
  ];
  return [
    corner(rect.minU - grow, rect.minV - grow),
    corner(rect.maxU + grow, rect.minV - grow),
    corner(rect.maxU + grow, rect.maxV + grow),
    corner(rect.minU - grow, rect.maxV + grow),
  ];
}

/**
 * PaddleOCR's order: the two leftmost corners start the text, the higher
 * of them first.
 */
export function orderQuad(quad: readonly Point[]): Quad {
  const byX = quad.toSorted((a, b) => a[0] - b[0]);
  const [tl, bl] = byX[0]![1] <= byX[1]![1] ? [byX[0]!, byX[1]!] : [byX[1]!, byX[0]!];
  const [tr, br] = byX[2]![1] <= byX[3]![1] ? [byX[2]!, byX[3]!] : [byX[3]!, byX[2]!];
  return [tl, tr, br, bl];
}

/**
 * DB's post-processing: a threshold, 8-connected regions, the smallest
 * rotated rectangle around each, grown back out by the unclip ratio.
 */
export function boxesFromMap(
  prob: Float32Array,
  size: { H: number; W: number },
  options: Pick<PipelineOptions, "boxThresh" | "detThresh" | "minSide" | "unclip">,
): { quad: Quad; score: number }[] {
  const { H, W } = size;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: { quad: Quad; score: number }[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] === 1 || prob[start]! <= options.detThresh) continue;
    let top = 0;
    let sum = 0;
    let count = 0;
    stack[top++] = start;
    seen[start] = 1;
    const rowMin = new Map<number, number>();
    const rowMax = new Map<number, number>();
    while (top > 0) {
      const at = stack[--top]!;
      const x = at % W;
      const y = (at - x) / W;
      sum += prob[at]!;
      count++;
      rowMin.set(y, Math.min(rowMin.get(y) ?? x, x));
      rowMax.set(y, Math.max(rowMax.get(y) ?? x, x));
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const next = ny * W + nx;
          if (seen[next] === 0 && prob[next]! > options.detThresh) {
            seen[next] = 1;
            stack[top++] = next;
          }
        }
      }
    }
    if (count < 9 || sum / count < options.boxThresh) continue;
    const points: Point[] = [];
    for (const [y, x] of rowMin) points.push([x, y], [x, y + 1]);
    for (const [y, x] of rowMax) points.push([x + 1, y], [x + 1, y + 1]);
    const rect = minAreaRect(convexHull(points));
    if (rect === null || Math.min(rect.w, rect.h) < options.minSide) continue;
    const grow = (rect.w * rect.h * options.unclip) / (2 * (rect.w + rect.h));
    out.push({ quad: orderQuad(rectCorners(rect, grow)), score: sum / count });
  }
  return out;
}

const centre = (quad: Quad): Point => [
  (quad[0][0] + quad[2][0]) / 2,
  (quad[0][1] + quad[2][1]) / 2,
];

/** Top to bottom, then left to right within about a line's height. */
export function sortReading<T extends { quad: Quad }>(boxes: readonly T[]): T[] {
  return boxes.toSorted((a, b) => {
    const p = centre(a.quad);
    const q = centre(b.quad);
    return Math.abs(p[1] - q[1]) > 12 ? p[1] - q[1] : p[0] - q[0];
  });
}

export type Decoded = {
  conf: number;
  text: string;
  /** Each word, and where along the crop (0 to 1) its letters fired. */
  words: { a: number; b: number; conf: number; text: string }[];
};

const mean = (list: { p: number }[]) =>
  list.reduce((total, item) => total + item.p, 0) / list.length;

/**
 * Greedy CTC: the likeliest symbol at each time step, repeats and blanks
 * dropped; words split at spaces, each spanning the steps its letters
 * fired on, half a letter's step either side.
 */
export function ctcDecode(
  data: Float32Array,
  steps: number,
  classes: number,
  chars: readonly string[],
): Decoded {
  const items: { ch: string; p: number; t: number }[] = [];
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let value = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = data[t * classes + c]!;
      if (v > value) {
        value = v;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) items.push({ ch: chars[best] ?? "", p: value, t });
    previous = best;
  }
  const words: Decoded["words"] = [];
  let current: typeof items = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current.at(-1)!;
    const half =
      0.5 * Math.max(1, current.length > 1 ? (last.t - first.t) / (current.length - 1) : 2);
    words.push({
      a: Math.max(0, (first.t + 0.5 - half) / steps),
      b: Math.min(1, (last.t + 0.5 + half) / steps),
      conf: mean(current),
      text: current.map((item) => item.ch).join(""),
    });
    current = [];
  };
  for (const item of items) {
    if (item.ch === " " || item.ch === "　") flush();
    else current.push(item);
  }
  flush();
  return {
    conf: items.length > 0 ? mean(items) : 0,
    text: items.map((item) => item.ch).join(""),
    words,
  };
}

const at = (frame: Frame, a: number, c: number): Point => [
  frame.o[0] + frame.u[0] * a + frame.v[0] * c,
  frame.o[1] + frame.u[1] * a + frame.v[1] * c,
];

/**
 * How a detected box reads: along its long side, and, for a box taller
 * than wide, turned a quarter (rotated labels on maps).
 */
export function frameOf(quad: Quad): { frame: Frame; tall: boolean } {
  const [tl, tr, br, bl] = quad;
  const tall = dist(tl, bl) / Math.max(1, dist(tl, tr)) >= 1.5;
  const frame = tall
    ? { o: tr, u: sub(br, tr), v: sub(tl, tr) }
    : { o: tl, u: sub(tr, tl), v: sub(bl, tl) };
  return { frame, tall };
}

export const flipped = (frame: Frame): Frame => ({
  o: add(add(frame.o, frame.u), frame.v),
  u: neg(frame.u),
  v: neg(frame.v),
});

export type Tensor = { data: unknown; dims: readonly number[] };
export type Session = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  release?: () => Promise<void>;
  run: (feeds: Record<string, unknown>) => Promise<Record<string, Tensor>>;
};
export type Runtime = {
  makeTensor: (data: Float32Array, dims: number[]) => unknown;
  session: (model: Uint8Array) => Promise<Session>;
};

export type Pipeline = {
  recognize: (
    img: Pixels,
  ) => Promise<{ boxes: number; detMs: number; recMs: number; words: PaddleWord[] }>;
  release: () => Promise<void>;
};

export async function createPipeline({
  dict,
  models,
  options = DEFAULT_OPTIONS,
  runtime,
}: {
  /** Ordered dictionary symbols without the CTC blank or appended space. */
  dict: readonly string[];
  models: { detector: Uint8Array; recogniser: Uint8Array };
  options?: PipelineOptions;
  runtime: Runtime;
}): Promise<Pipeline> {
  const detector = await runtime.session(models.detector);
  const recogniser = await runtime.session(models.recogniser);
  const chars = ["", ...dict, " "];

  async function detect(img: Pixels) {
    const k = Math.min(1, options.detMaxSide / Math.max(img.width, img.height));
    const W = Math.max(32, Math.round((img.width * k) / 32) * 32);
    const H = Math.max(32, Math.round((img.height * k) / 32) * 32);
    const input = runtime.makeTensor(resizeToChw(img, { H, W }), [1, 3, H, W]);
    const out = await detector.run({ [detector.inputNames[0]!]: input });
    const prob = out[detector.outputNames[0]!]!.data as Float32Array;
    return boxesFromMap(prob, { H, W }, options).map(({ quad, score }) => ({
      quad: quad.map(([x, y]) => [(x * img.width) / W, (y * img.height) / H]) as Quad,
      score,
    }));
  }

  async function read(img: Pixels, frame: Frame): Promise<Decoded> {
    const w = Math.hypot(frame.u[0], frame.u[1]);
    const h = Math.hypot(frame.v[0], frame.v[1]);
    const H = options.recHeight;
    const W = Math.max(16, Math.min(options.recMaxWidth, Math.round((H * w) / Math.max(1, h))));
    const input = runtime.makeTensor(sampleFrame(img, frame, { H, W }), [1, 3, H, W]);
    const out = await recogniser.run({ [recogniser.inputNames[0]!]: input });
    const tensor = out[recogniser.outputNames[0]!]!;
    return ctcDecode(tensor.data as Float32Array, tensor.dims[1]!, tensor.dims[2]!, chars);
  }

  async function recognize(img: Pixels) {
    const started = performance.now();
    const boxes = await detect(img);
    const detected = performance.now();
    const words: PaddleWord[] = [];
    let line = 0;
    for (const box of sortReading(boxes)) {
      let { frame, tall } = frameOf(box.quad);
      let reading = await read(img, frame);
      if (tall || reading.conf < options.flipBelow) {
        const other = flipped(frame);
        const again = await read(img, other);
        if (again.conf > reading.conf + 0.02) {
          reading = again;
          frame = other;
        }
      }
      if (reading.text.trim().length === 0 || reading.conf < options.minConf) continue;
      for (const word of reading.words) {
        const quad: Quad = [
          at(frame, word.a, 0),
          at(frame, word.b, 0),
          at(frame, word.b, 1),
          at(frame, word.a, 1),
        ];
        words.push({ conf: word.conf, line, quad, text: word.text });
      }
      line++;
    }
    return {
      boxes: boxes.length,
      detMs: detected - started,
      recMs: performance.now() - detected,
      words,
    };
  }

  return {
    recognize,
    release: async () => {
      await detector.release?.();
      await recogniser.release?.();
    },
  };
}
