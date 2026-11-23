import type { Box, EngineName, Quad, TextLine, TextResult, TextWord } from "../../src/text-result";
import type { Point } from "./search-index";

import { fold } from "./search-text";

// Which of what the engines read goes into the board's search (README,
// "Text in images"). Engines also "read" a map's mountains, trees and
// hatching as short words; those would answer searches with places that
// say nothing. A word stays when:
// - it holds a letter or a digit;
// - its engine is confident enough (MIN_CONFIDENCE), and a Tesseract word
//   that is only fairly sure (under SURE) is backed by another reading:
//   PP-OCR read something in the same place, or its own line holds sure
//   words around it;
// - its box fits its letters (no needle or slab a few letters long);
// - it is not one lone letter or symbol: alone, a letter is a mountain;
// and where both engines read the same word in the same place, it is
// indexed once (Tesseract's, which keeps diacritics better). Both
// readings stay as text otherwise: a misread in one is often right in
// the other.

export const MIN_CONFIDENCE = 0.5;
export const SURE = 0.8;
// The width of one letter against the height of the line, outside which
// a box is not text.
const LETTER_ASPECT = { max: 3, min: 0.12 };

export type ReadWord = { region: Point[]; text: string };
export type ReadLine = { engine: EngineName; region: Point[]; text: string; words: ReadWord[] };

type Candidate = TextWord & { engine: EngineName; line: number };

const LETTERS = /[\p{L}\p{N}]/gu;
// PP-OCR's dictionary is mostly Chinese; on a board of Latin text a Han
// character is a drawing misread.
const FOREIGN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// What trees, towns and dots on a map read as.
const RINGS = /^[0oO8°Qº]+$/u;
const LONE_SURE = 0.9;

const cornersOf = (word: Pick<TextWord, "b" | "q">): Point[] => {
  if (word.q !== undefined) {
    const { q } = word;
    return [0, 2, 4, 6].map((at) => ({ x: q[at]!, y: q[at + 1]! }));
  }
  const [x0, y0, x1, y1] = word.b;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// How long the word runs and how tall its letters are, in its own frame.
function extent(word: TextWord): { across: number; along: number } {
  const [tl, tr, , bl] = cornersOf(word);
  return { across: distance(tl!, bl!), along: distance(tl!, tr!) };
}

const area = ([x0, y0, x1, y1]: Box) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

// The share of the smaller box that the two boxes have in common.
export function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const smaller = Math.min(area(a), area(b));
  return smaller === 0 ? 0 : (x * y) / smaller;
}

const SAME_PLACE = 0.5;

function fitsItsLetters(word: TextWord): boolean {
  const { across, along } = extent(word);
  const letters = [...word.t].length;
  if (across === 0) return false;
  const aspect = along / letters / across;
  return aspect >= LETTER_ASPECT.min && aspect <= LETTER_ASPECT.max;
}

function candidates(reading: TextResult): Candidate[][] {
  return reading.lines.map((line, at) =>
    line.words.map((word) => ({ ...word, engine: reading.engine.name, line: at })),
  );
}

function backed(word: Candidate, line: Candidate[], others: Candidate[]): boolean {
  if (word.engine !== "tesseract" || word.c >= SURE) return true;
  if (
    others.some((other) => other.engine !== word.engine && overlap(other.b, word.b) >= SAME_PLACE)
  ) {
    return true;
  }
  return line.filter((other) => other !== word && other.c >= SURE).length >= 2;
}

// A word alone on its line, of a few symbols: a room number on a plan,
// or a mountain or a tree.
function loneAndShort(word: Candidate, line: Candidate[]): boolean {
  if (line.length > 1) return false;
  const symbols = [...word.t];
  if (symbols.length === 1 && !/\p{N}/u.test(word.t)) return true;
  return symbols.length <= 3 && (word.c < LONE_SURE || RINGS.test(word.t));
}

function keep(word: Candidate, line: Candidate[], everyone: Candidate[]): boolean {
  const symbols = [...word.t].length;
  const letters = word.t.match(LETTERS)?.length ?? 0;
  if (letters === 0 || letters * 2 < symbols || FOREIGN.test(word.t)) return false;
  if (word.c < MIN_CONFIDENCE || !fitsItsLetters(word) || loneAndShort(word, line)) return false;
  return backed(word, line, everyone);
}

const quadOf = (line: TextLine): Quad | undefined => line.quad;

function lineRegion(words: TextWord[], source: TextLine): Point[] {
  const whole = quadOf(source);
  if (whole !== undefined && words.length === source.words.length) {
    return cornersOf({ b: source.box, q: whole });
  }
  const first = cornersOf(words[0]!);
  const last = cornersOf(words.at(-1)!);
  if (words[0]!.q !== undefined) return [first[0]!, last[1]!, last[2]!, first[3]!];
  const boxes = words.map((word) => word.b);
  return cornersOf({
    b: [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ],
  });
}

// Tesseract first: where both read the same word, its reading is the one
// indexed.
const ORDER: Record<EngineName, number> = { ppocr: 1, tesseract: 0 };

// The lines of an image to index, from every engine's reading of it, in
// either order of arrival.
export function linesToIndex(readings: readonly TextResult[]): ReadLine[] {
  const sorted = readings.toSorted((a, b) => ORDER[a.engine.name] - ORDER[b.engine.name]);
  const byReading = sorted.map((reading) => ({ lines: candidates(reading), reading }));
  const everyone = byReading.flatMap(({ lines }) => lines.flat());
  const indexed: Candidate[] = [];
  const out: ReadLine[] = [];
  for (const { lines, reading } of byReading) {
    for (const [at, line] of lines.entries()) {
      const kept = line.filter(
        (word) =>
          keep(word, line, everyone) &&
          !indexed.some(
            (other) =>
              other.engine !== word.engine &&
              fold(other.t) === fold(word.t) &&
              overlap(other.b, word.b) >= SAME_PLACE,
          ),
      );
      if (kept.length === 0) continue;
      indexed.push(...kept);
      out.push({
        engine: reading.engine.name,
        region: lineRegion(kept, reading.lines[at]!),
        text: kept.map((word) => word.t).join(" "),
        words: kept.map((word) => ({ region: cornersOf(word), text: word.t })),
      });
    }
  }
  return out;
}
