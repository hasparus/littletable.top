import { MAX_TEXT_RESULT_BYTES, MAX_TEXT_WORDS, MAX_WORD_LENGTH } from "./limits";

export const TEXT_FORMAT = "ocr/1";

/** Changing OCR models or parameters requires a new engine key, leaving stored readings addressable. */
export const TEXT_ENGINES = {
  "ppocr-v6tiny.1": {
    model: "PP-OCRv6_tiny_det+PP-OCRv6_tiny_rec",
    name: "ppocr",
    version: "v6tiny.1",
  },
  "tesseract-6.0.1": {
    model: "tessdata_fast-4.1.0:pol+eng",
    name: "tesseract",
    version: "6.0.1",
  },
} as const;

export type EngineKey = keyof typeof TEXT_ENGINES;
export type EngineName = (typeof TEXT_ENGINES)[EngineKey]["name"];

export const isEngineKey = (key: string): key is EngineKey => Object.hasOwn(TEXT_ENGINES, key);

/** [x0, y0, x1, y1], upright. */
export type Box = [number, number, number, number];
/**
 * Four corners, x and y in turn, clockwise from the top left of the text
 * as it reads: a tilted label's tilted outline.
 */
export type Quad = [number, number, number, number, number, number, number, number];

export type TextWord = { b: Box; c: number; q?: Quad; t: string };
export type TextLine = { box: Box; quad?: Quad; words: TextWord[] };
export type TextSource = "peer" | "uploader";

export type TextResult = {
  createdAt: string;
  engine: {
    model: string;
    name: EngineName;
    params: Record<string, boolean | number | string>;
    version: string;
  };
  format: typeof TEXT_FORMAT;
  image: { height: number; sha256: string; width: number };
  lines: TextLine[];
  source: TextSource;
};

// WARNING: Accepting bidi overrides would let uploaded text change its display order.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function normaliseWord(text: string): string {
  const kept = text.normalize("NFC").replaceAll(UNSEEN, "").replaceAll(/\s+/gu, "");
  return [...kept].slice(0, MAX_WORD_LENGTH).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Invalid extends Error {
  override name = "Invalid";
}

function check(condition: boolean, problem: string): asserts condition {
  if (!condition) throw new Invalid(problem);
}

const numbers = (value: unknown, length: number, problem: string): number[] => {
  check(Array.isArray(value) && value.length === length, problem);
  return (value as unknown[]).map((item) => {
    check(typeof item === "number" && Number.isFinite(item), problem);
    return Math.round(item as number);
  });
};

type Size = { height: number; width: number };

function box(value: unknown, { height, width }: Size): Box {
  const [x0, y0, x1, y1] = numbers(value, 4, "box") as Box;
  check(x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height, "box outside the image");
  check(x0 < x1 && y0 < y1, "box without area");
  return [x0, y0, x1, y1];
}

function quad(value: unknown, { height, width }: Size): Quad {
  const corners = numbers(value, 8, "quad") as Quad;
  let twice = 0;
  for (let at = 0; at < 8; at += 2) {
    const [x, y] = [corners[at]!, corners[at + 1]!];
    check(x >= 0 && y >= 0 && x <= width && y <= height, "quad outside the image");
    const [nx, ny] = [corners[(at + 2) % 8]!, corners[(at + 3) % 8]!];
    twice += x * ny - nx * y;
  }
  check(twice !== 0, "quad without area");
  return corners;
}

function word(value: unknown, size: Size): TextWord | null {
  check(isRecord(value), "word");
  check(typeof value.t === "string", "word text");
  check(typeof value.c === "number" && value.c >= 0 && value.c <= 1, "confidence");
  const text = normaliseWord(value.t);
  const kept: TextWord = { b: box(value.b, size), c: Math.round(value.c * 100) / 100, t: text };
  if (value.q !== undefined) kept.q = quad(value.q, size);
  return text.length === 0 ? null : kept;
}

function params(value: unknown): TextResult["engine"]["params"] {
  check(isRecord(value), "params");
  const entries = Object.entries(value);
  check(entries.length <= 16, "params");
  for (const [name, item] of entries) {
    check(/^[A-Za-z]\w{0,31}$/u.test(name), "params");
    check(
      typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        (typeof item === "string" && item.length <= 64),
      "params",
    );
  }
  return Object.fromEntries(entries) as TextResult["engine"]["params"];
}

/**
 * The image's size as it shows (src/image-size.ts). When that is not
 * `exact` (an orientation the Worker does not read), either way up is
 * accepted.
 */
export type Expected = {
  createdAt: string;
  engine: EngineKey;
  exact: boolean;
  height: number;
  sha256: string;
  width: number;
};

export function validateTextResult(
  raw: unknown,
  expected: Expected,
): { problem: string } | { result: TextResult } {
  try {
    check(isRecord(raw) && raw.format === TEXT_FORMAT, "format");
    const { engine, image } = raw;
    check(isRecord(image) && image.sha256 === expected.sha256, "image");
    const size = { height: image.height, width: image.width };
    check(
      (size.width === expected.width && size.height === expected.height) ||
        (!expected.exact && size.width === expected.height && size.height === expected.width),
      "image size",
    );
    const known = TEXT_ENGINES[expected.engine];
    check(
      isRecord(engine) &&
        engine.name === known.name &&
        engine.version === known.version &&
        engine.model === known.model,
      "engine",
    );
    check(raw.source === "peer" || raw.source === "uploader", "source");
    check(Array.isArray(raw.lines), "lines");
    const dimensions = size as Size;
    // WARNING: Using only the global word limit lets a tiny image carry an implausibly large reading.
    const most = Math.min(
      MAX_TEXT_WORDS,
      Math.max(64, Math.floor((dimensions.width * dimensions.height) / 64)),
    );
    let words = 0;
    const lines: TextLine[] = [];
    for (const line of raw.lines as unknown[]) {
      check(isRecord(line) && Array.isArray(line.words), "line");
      const kept = (line.words as unknown[]).flatMap((item) => {
        const read = word(item, dimensions);
        return read === null ? [] : [read];
      });
      words += kept.length;
      check(words <= most, "too many words");
      const outline: TextLine = { box: box(line.box, dimensions), words: kept };
      if (line.quad !== undefined) outline.quad = quad(line.quad, dimensions);
      if (kept.length > 0) lines.push(outline);
    }
    const result: TextResult = {
      createdAt: expected.createdAt,
      engine: {
        model: known.model,
        name: known.name,
        params: params(engine.params),
        version: known.version,
      },
      format: TEXT_FORMAT,
      image: { height: dimensions.height, sha256: expected.sha256, width: dimensions.width },
      lines,
      source: raw.source as TextSource,
    };
    check(
      new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_TEXT_RESULT_BYTES,
      "too large",
    );
    return { result };
  } catch (error) {
    if (error instanceof Invalid) return { problem: error.message };
    throw error;
  }
}
