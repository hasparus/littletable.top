import { describe, expect, it } from "vitest";

import { MAX_TEXT_RESULT_BYTES, MAX_TEXT_WORDS, MAX_WORD_LENGTH } from "../src/limits";
import {
  type Expected,
  TEXT_ENGINES,
  type TextResult,
  validateTextResult,
} from "../src/text-result";

const SHA = "a".repeat(64);
const EXPECTED: Expected = {
  createdAt: "2026-11-23T10:00:00.000Z",
  engine: "tesseract-6.0.1",
  exact: true,
  height: 300,
  sha256: SHA,
  width: 400,
};

const { model, name, version } = TEXT_ENGINES["tesseract-6.0.1"];

function sent(lines: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "1999-01-01T00:00:00.000Z",
    engine: { model, name, params: { psm: 11 }, version },
    format: "ocr/1",
    image: { height: 300, sha256: SHA, width: 400 },
    lines,
    source: "uploader",
    ...overrides,
  };
}

const word = (t: string, b = [10, 10, 60, 30], extra: object = {}) => ({ b, c: 0.9, t, ...extra });
const line = (...words: object[]) => ({ box: [10, 10, 200, 30], words });

const problem = (raw: unknown) => {
  const checked = validateTextResult(raw, EXPECTED);
  return "problem" in checked ? checked.problem : null;
};

const kept = (raw: unknown): TextResult => {
  const checked = validateTextResult(raw, EXPECTED);
  if ("problem" in checked) throw new Error(checked.problem);
  return checked.result;
};

describe("a text result a browser sends", () => {
  it("is kept with only the format's fields, the board's own time and rounded numbers", () => {
    const result = kept({
      ...sent([
        {
          ...line(
            word("Gród", [10.4, 10.6, 59.5, 30.2], {
              c: 0.876,
              q: [10, 10, 60, 10, 60, 30, 10, 30],
              x: 1,
            }),
          ),
          extra: true,
        },
      ]),
      secret: "kept?",
    });
    expect(result).toEqual({
      createdAt: EXPECTED.createdAt,
      engine: { model, name, params: { psm: 11 }, version },
      format: "ocr/1",
      image: { height: 300, sha256: SHA, width: 400 },
      lines: [
        {
          box: [10, 10, 200, 30],
          words: [{ b: [10, 11, 60, 30], c: 0.88, q: [10, 10, 60, 10, 60, 30, 10, 30], t: "Gród" }],
        },
      ],
      source: "uploader",
    });
  });

  it("must state the image's size as it shows, either way up only where that is unknown", () => {
    expect(problem(sent([], { image: { height: 300, sha256: SHA, width: 401 } }))).toBe(
      "image size",
    );
    const turned = sent([], { image: { height: 400, sha256: SHA, width: 300 } });
    expect(problem(turned)).toBe("image size");
    expect(
      "problem" in validateTextResult(turned, { ...EXPECTED, exact: false }),
      "a PNG's or WebP's EXIF is not read",
    ).toBe(false);
    expect(problem(sent([], { image: { height: 300, sha256: "b".repeat(64), width: 400 } }))).toBe(
      "image",
    );
  });

  it("must name the engine its key stands for", () => {
    expect(problem(sent([], { engine: { model, name: "vision", params: {}, version } }))).toBe(
      "engine",
    );
    expect(problem(sent([], { engine: { model: "best", name, params: {}, version } }))).toBe(
      "engine",
    );
    expect(
      problem(sent([], { engine: { model, name, params: { a: { deep: 1 } }, version } })),
    ).toBe("params");
    expect(problem(sent([], { format: "tl-ocr/1" }))).toBe("format");
    expect(problem(sent([], { source: "server" }))).toBe("source");
  });

  it("keeps every box inside the image, with an area", () => {
    expect(problem(sent([line(word("a", [-1, 10, 60, 30]))]))).toBe("box outside the image");
    expect(problem(sent([line(word("a", [10, 10, 401, 30]))]))).toBe("box outside the image");
    expect(problem(sent([line(word("a", [10, 10, 10, 30]))]))).toBe("box without area");
    expect(problem(sent([line(word("a", [10, 10, 60, Number.NaN]))]))).toBe("box");
    expect(problem(sent([{ box: [0, 0, 500, 20], words: [word("a")] }]))).toBe(
      "box outside the image",
    );
    expect(problem(sent([line(word("a", undefined, { q: [0, 0, 9, 0, 9, 0, 0, 0] }))]))).toBe(
      "quad without area",
    );
    expect(problem(sent([line(word("a", undefined, { q: [0, 0, 9, 0, 9, 301, 0, 9] }))]))).toBe(
      "quad outside the image",
    );
  });

  it("keeps confidence between 0 and 1", () => {
    expect(problem(sent([line(word("a", undefined, { c: 1.01 }))]))).toBe("confidence");
    expect(problem(sent([line(word("a", undefined, { c: -0.1 }))]))).toBe("confidence");
  });

  it("drops hidden characters, spells letters one way and caps a word's length", () => {
    const result = kept(
      sent([
        line(
          word("Gród"),
          word("ab‮c\u0000d​"),
          word("\u0007\u0008"),
          word("x".repeat(MAX_WORD_LENGTH + 10)),
          word("in side"),
        ),
      ]),
    );
    expect(result.lines[0]!.words.map((kept) => kept.t)).toEqual([
      "Gród",
      "abcd",
      "x".repeat(MAX_WORD_LENGTH),
      "inside",
    ]);
  });

  it("leaves out lines that keep no word", () => {
    expect(kept(sent([line(word("\u0000")), line(word("Młyn"))])).lines).toHaveLength(1);
  });

  it("refuses more words than the image has room for, or than any image may carry", () => {
    const many = (count: number) => Array.from({ length: count }, () => word("ab", [1, 1, 5, 5]));
    const small = { ...EXPECTED, height: 20, width: 20 };
    const crowded = { box: [1, 1, 19, 19], words: many(65) };
    const tiny = { ...sent([crowded]), image: { height: 20, sha256: SHA, width: 20 } };
    expect(validateTextResult(tiny, small)).toEqual({ problem: "too many words" });
    const huge = { ...EXPECTED, height: 4000, width: 4000 };
    const book = {
      ...sent([line(...many(MAX_TEXT_WORDS + 1))]),
      image: { height: 4000, sha256: SHA, width: 4000 },
    };
    expect(validateTextResult(book, huge)).toEqual({ problem: "too many words" });
  });

  it("refuses more bytes than a result may keep", () => {
    const long = "ł".repeat(MAX_WORD_LENGTH);
    const words = Array.from({ length: Math.ceil(MAX_TEXT_RESULT_BYTES / 100) }, () => word(long));
    const huge = { ...EXPECTED, height: 4000, width: 4000 };
    const raw = { ...sent([line(...words)]), image: { height: 4000, sha256: SHA, width: 4000 } };
    expect(validateTextResult(raw, huge)).toEqual({ problem: "too large" });
  });
});
