/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import type { Box, TextResult } from "../src/text-result";

import { linesToIndex, overlap } from "../client/src/text-filter";
import { score, type Truth } from "../e2e/text-score";

// What filtering can get wrong: it lets a map's drawings through as words
// (junk a search turns up), or it throws away names people search for;
// it gives a different answer depending on which engine's reading came
// first; it indexes the same word twice for the same place, or drops one
// engine's reading where it differs from the other's. The readings are
// what both engines read off the committed fixtures in Chromium
// (e2e/fixtures/text/*.read.json).

type Reading = Pick<TextResult, "lines"> & { engine: Pick<TextResult["engine"], "name"> };

const readings = import.meta.glob("../e2e/fixtures/text/*.read.json", {
  eager: true,
  import: "default",
}) as Record<string, Reading[]>;
const truths = import.meta.glob("../e2e/fixtures/text/*.gt.json", {
  eager: true,
  import: "default",
}) as Record<string, Truth>;

const fixtures = Object.entries(readings).map(([path, read]) => ({
  name: path.split("/").at(-1)!.replace(".read.json", ""),
  read: read as TextResult[],
  truth: truths[path.replace(".read.json", ".gt.json")]!,
}));

const box = (region: { x: number; y: number }[]): Box => [
  Math.min(...region.map((point) => point.x)),
  Math.min(...region.map((point) => point.y)),
  Math.max(...region.map((point) => point.x)),
  Math.max(...region.map((point) => point.y)),
];

const unfiltered = (read: TextResult[]) =>
  read.flatMap((reading) =>
    reading.lines.flatMap((line) => line.words.map((word) => ({ box: word.b, text: word.t }))),
  );

const indexed = (read: TextResult[]) =>
  linesToIndex(read).flatMap((line) =>
    line.words.map((word) => ({ box: box(word.region), text: word.text })),
  );

describe("filtering what the engines read", () => {
  it("has all six fixtures to work on", () => {
    expect(fixtures.map(({ name }) => name).toSorted()).toEqual([
      "handout_pl_photo",
      "map_pl",
      "rules_pl",
      "sheet_pl_clean",
      "sheet_pl_scan",
      "small_card_pl",
    ]);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    "keeps the names of %s that both engines found",
    (_name, { read, truth }) => {
      const before = score(truth, unfiltered(read));
      const after = score(truth, indexed(read));
      expect(after.namesMissed.filter((name) => !before.namesMissed.includes(name))).toEqual([]);
    },
  );

  it("throws most of a map's drawings away", () => {
    const map = fixtures.find(({ name }) => name === "map_pl")!;
    const before = score(map.truth, unfiltered(map.read)).junk;
    const after = score(map.truth, indexed(map.read)).junk;
    expect(before).toBeGreaterThan(100);
    expect(after).toBeLessThan(before / 4);
  });

  it("indexes each word once per place, whichever reading came first", () => {
    for (const { read } of fixtures) {
      const forwards = linesToIndex(read);
      expect(linesToIndex([...read].reverse())).toEqual(forwards);
      const words = forwards.flatMap((line) =>
        line.words.map((word) => ({ box: box(word.region), text: word.text })),
      );
      for (const [at, word] of words.entries()) {
        const twin = words.findIndex(
          (other, index) =>
            index !== at && other.text === word.text && overlap(other.box, word.box) >= 0.5,
        );
        expect(twin, word.text).toBe(-1);
      }
    }
  });

  it("keeps both readings of a place where they differ, and one where they agree", () => {
    const at = [100, 100, 220, 130];
    const of = (name: "ppocr" | "tesseract", ...texts: string[]) =>
      ({
        engine: { name },
        lines: texts.map((t, line) => ({
          box: [at[0]!, at[1]! + line * 50, at[2]!, at[3]! + line * 50],
          words: [{ b: [at[0]!, at[1]! + line * 50, at[2]!, at[3]! + line * 50], c: 0.95, t }],
        })),
      }) as unknown as TextResult;
    const lines = linesToIndex([
      of("ppocr", "Zbigniew", "Zolwia"),
      of("tesseract", "Zbignlew", "Żółwia"),
    ]);
    expect(lines.map(({ engine, text }) => `${engine}: ${text}`)).toEqual([
      "tesseract: Zbignlew",
      "tesseract: Żółwia",
      "ppocr: Zbigniew",
    ]);
  });

  it("drops a lone mark, a needle, a ring and a foreign character, but not a room number", () => {
    const reading = (words: [string, number, number[]][]): TextResult =>
      ({
        engine: { name: "ppocr" },
        lines: words.map(([t, c, b]) => ({ box: b, words: [{ b, c, t }] })),
      }) as unknown as TextResult;
    const lines = linesToIndex([
      reading([
        ["△", 0.99, [0, 0, 20, 20]],
        ["A", 0.96, [30, 0, 50, 20]],
        ["Il", 0.95, [60, 0, 64, 80]],
        ["00", 0.97, [70, 0, 110, 20]],
        ["七", 0.9, [120, 0, 140, 20]],
        ["12", 0.95, [150, 0, 175, 20]],
        ["Młyn", 0.4, [200, 0, 260, 20]],
        ["Młyn", 0.9, [300, 0, 360, 20]],
      ]),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["12", "Młyn"]);
  });
});
