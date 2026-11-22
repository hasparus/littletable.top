import { create, type Font } from "fontkit";

import { FONT_DATA } from "./font-data.generated";

// Measures text the way tldraw's editor does in a browser (TextManager: a
// `white-space: pre-wrap; overflow-wrap: break-word` box, `width:
// max-content` between a min and a max width, whole-pixel line height), but
// with no DOM: tldraw's own font files are shaped by fontkit, as HarfBuzz
// shapes them in Chrome. Glyphs none of tldraw's fonts has (CJK, emoji)
// come from the reader's system fonts in a browser, which a server cannot
// know; they get typical widths and the answer says it is approximate.

export type FontFamily = "draw" | "mono" | "sans" | "serif";

export type MeasureOptions = {
  family: FontFamily;
  fontSize: number;
  /** tldraw's unitless multiplier, 1.35 by default. */
  lineHeight: number;
  /** Wrap at this width; null measures the text as one line per paragraph. */
  maxWidth: number | null;
  minWidth?: number | null;
  /** false is tldraw's `disableOverflowWrapBreaking`: a long word overflows. */
  overflowWrap?: boolean;
};

export type Measured = {
  /** A glyph came from a fallback width, not from a tldraw font. */
  approximate: boolean;
  h: number;
  lines: number;
  /** The widest line, which exceeds w when a word overflows. */
  scrollWidth: number;
  w: number;
};

type Run = { bold: boolean; text: string };
type Paragraph = Run[];

type Grapheme = {
  /** Whether a line may break before this grapheme. */
  breakBefore: boolean;
  space: boolean;
  width: number;
};

const EMOJI_EM = 1.245;
const WIDE_EM = 1;
const OTHER_EM = 0.6;

const fonts = new Map<string, Font>();

function fontFor(family: FontFamily, bold: boolean): Font {
  const key = `${family}/${bold ? "bold" : "normal"}`;
  let font = fonts.get(key);
  if (font === undefined) {
    const data = FONT_DATA[key];
    if (data === undefined) throw new Error(`no font data for ${key}`);
    font = create(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) as never) as Font;
    fonts.set(key, font);
  }
  return font;
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}|\p{M}/u;
// East Asian wide and fullwidth letters, which are one em in any CJK font.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
// Letters a line may break before and after, as UAX #14 class ID does.
const IDEOGRAPHIC = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿\u{20000}-\u{3FFFD}]/u;
// Closing punctuation no line may start with.
const NO_BREAK_BEFORE = /^[)\]}»”’,.:;!?、。〉》」』】〕〗〙〛）］｝｡､ー々ゝゞヽヾ]/u;
const DIGIT = /^\p{Nd}/u;

function fallbackEm(grapheme: string): number {
  if (EXTENDED_PICTOGRAPHIC.test(grapheme)) return EMOJI_EM;
  if (WIDE.test(grapheme)) return WIDE_EM;
  return OTHER_EM;
}

function covered(font: Font, grapheme: string): boolean {
  for (const char of grapheme) {
    if (DEFAULT_IGNORABLE.test(char)) continue;
    if (!font.hasGlyphForCodePoint(char.codePointAt(0)!)) return false;
  }
  return true;
}

// The advance of each grapheme of a run the font covers, in font units,
// shaped as one piece so that kerning and contextual alternates apply.
function shape(font: Font, pieces: string[]): number[] {
  const { glyphs, positions } = font.layout(pieces.join(""));
  const perCodePoint: number[] = [];
  glyphs.forEach((glyph, index) => {
    perCodePoint.push(positions[index]!.xAdvance);
    for (let extra = 1; extra < glyph.codePoints.length; extra++) perCodePoint.push(0);
  });
  const widths: number[] = [];
  let at = 0;
  for (const piece of pieces) {
    const count = [...piece].length;
    let width = 0;
    for (let index = at; index < at + count; index++) width += perCodePoint[index] ?? 0;
    widths.push(width);
    at += count;
  }
  return widths;
}

// Boards repeat their words, so each word is shaped once per font. Shaping
// word by word loses kerning against the space around it, which tldraw's
// fonts do not have.
const SHAPED_WORDS_KEPT = 20_000;
const shapedWords = new Map<string, number[]>();

function shapeWords(face: string, font: Font, pieces: string[]): number[] {
  const out: number[] = [];
  let word: string[] = [];
  const flush = () => {
    if (word.length === 0) return;
    const key = `${face}\u0000${word.join("")}`;
    let widths = shapedWords.get(key);
    if (widths === undefined) {
      widths = shape(font, word);
      if (shapedWords.size >= SHAPED_WORDS_KEPT) shapedWords.clear();
      shapedWords.set(key, widths);
    }
    out.push(...widths);
    word = [];
  };
  for (const piece of pieces) {
    if (piece === " ") {
      flush();
      word = [piece];
      flush();
    } else {
      word.push(piece);
    }
  }
  flush();
  return out;
}

function layoutParagraph(paragraph: Paragraph, options: MeasureOptions) {
  const out: (Grapheme & { text: string })[] = [];
  let approximate = false;
  for (const run of paragraph) {
    const face = `${options.family}/${run.bold ? "bold" : "normal"}`;
    const font = fontFor(options.family, run.bold);
    const scale = options.fontSize / font.unitsPerEm;
    const pieces = [...graphemes.segment(run.text)].map(({ segment }) => segment);
    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const widths = shapeWords(face, font, pending);
      pending.forEach((text, index) =>
        out.push({ breakBefore: false, space: text === " ", text, width: widths[index]! * scale }),
      );
      pending = [];
    };
    for (const piece of pieces) {
      if (piece === "\t") {
        flush();
        out.push({ breakBefore: false, space: true, text: piece, width: 0 });
      } else if (covered(font, piece)) {
        pending.push(piece);
      } else {
        flush();
        approximate = true;
        out.push({
          breakBefore: false,
          space: false,
          text: piece,
          width: fallbackEm(piece) * options.fontSize,
        });
      }
    }
    flush();
  }
  // NOTE: tab stops are every two spaces wide (tldraw's --tl-tab-size).
  const regular = fontFor(options.family, false);
  const spaceWidth = (shape(regular, [" "])[0]! * options.fontSize) / regular.unitsPerEm;
  let x = 0;
  for (const g of out) {
    if (g.text === "\t") {
      const stop = spaceWidth * 2;
      g.width = stop - (x % stop) || stop;
    }
    x += g.width;
  }
  markBreaks(out);
  return { approximate, graphemes: out };
}

// A reduced UAX #14: break after spaces, after a hyphen or dash between
// letters, around ideographs and emoji, never before closing punctuation.
// NOTE: Chrome does not break after a slash ("example.org/a/path" wraps as
// one long word), which the harness confirmed.
function markBreaks(items: (Grapheme & { text: string })[]) {
  for (let index = 1; index < items.length; index++) {
    const before = items[index - 1]!.text;
    const here = items[index]!;
    if (here.space) continue;
    if (NO_BREAK_BEFORE.test(here.text)) continue;
    const afterSpace = items[index - 1]!.space;
    const afterHyphen =
      /^[-‐–]$/u.test(before) && index >= 2 && !items[index - 2]!.space && !DIGIT.test(here.text);
    const dash = before === "—" || here.text === "—";
    const ideographic =
      IDEOGRAPHIC.test(here.text) ||
      IDEOGRAPHIC.test(before) ||
      EXTENDED_PICTOGRAPHIC.test(here.text) ||
      EXTENDED_PICTOGRAPHIC.test(before);
    here.breakBefore = afterSpace || afterHyphen || dash || ideographic;
  }
}

// Greedy line filling, as browsers do: a line takes words while they fit;
// spaces at the end of a line hang outside it; a word wider than a line
// starts its own and, with overflow-wrap, breaks between graphemes.
function wrap(items: Grapheme[], maxWidth: number, overflowWrap: boolean) {
  const lines: number[] = [];
  let line = 0;
  let lineHasInk = false;
  let index = 0;
  const words: { items: Grapheme[]; spaces: number; width: number }[] = [];
  while (index < items.length) {
    const word: Grapheme[] = [items[index]!];
    index++;
    while (index < items.length && !items[index]!.breakBefore) {
      word.push(items[index]!);
      index++;
    }
    let spaces = 0;
    while (word.length > 0 && word.at(-1)!.space) spaces += word.pop()!.width;
    words.push({ items: word, spaces, width: word.reduce((sum, g) => sum + g.width, 0) });
  }
  let trailing = 0;
  for (const word of words) {
    if (lineHasInk && line + trailing + word.width > maxWidth + 0.01) {
      lines.push(line);
      line = 0;
      lineHasInk = false;
      trailing = 0;
    }
    if (!lineHasInk && word.width > maxWidth + 0.01 && overflowWrap) {
      for (const g of word.items) {
        if (lineHasInk && line + g.width > maxWidth + 0.01) {
          lines.push(line);
          line = 0;
        }
        line += g.width;
        lineHasInk = true;
      }
    } else {
      line += trailing + word.width;
      lineHasInk = lineHasInk || word.items.length > 0;
    }
    trailing = word.spaces;
  }
  lines.push(line);
  return lines;
}

export function measureParagraphs(paragraphs: Paragraph[], options: MeasureOptions): Measured {
  const lineHeight = Math.round(options.fontSize * options.lineHeight);
  let approximate = false;
  let maxContent = 0;
  const laid = paragraphs.map((paragraph) => {
    const result = layoutParagraph(paragraph, options);
    approximate = approximate || result.approximate;
    const width = result.graphemes.reduce((sum, g) => sum + g.width, 0);
    maxContent = Math.max(maxContent, width);
    return result.graphemes;
  });
  const minWidth = options.minWidth ?? 0;
  const w =
    options.maxWidth === null
      ? Math.max(minWidth, maxContent)
      : Math.max(minWidth, Math.min(maxContent, options.maxWidth));
  let lines = 0;
  let scrollWidth = 0;
  for (const items of laid) {
    const widths =
      options.maxWidth === null || maxContent <= w
        ? [items.reduce((sum, g) => sum + g.width, 0)]
        : wrap(items, w, options.overflowWrap ?? true);
    lines += widths.length;
    scrollWidth = Math.max(scrollWidth, ...widths);
  }
  return { approximate, h: lines * lineHeight, lines, scrollWidth: Math.max(w, scrollWidth), w };
}

type RichNode = { content?: RichNode[]; marks?: { type: string }[]; text?: string; type: string };

// tldraw's rich text (TipTap's JSON) as paragraphs of runs. Blocks other
// than paragraphs and headings are read for their text alone.
export function paragraphsOf(richText: { content: unknown[] }): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const visit = (node: RichNode) => {
    if (node.type === "paragraph" || node.type === "heading") {
      let runs: Run[] = [];
      for (const child of node.content ?? []) {
        if (child.type === "hardBreak") {
          paragraphs.push(runs);
          runs = [];
        } else if (child.type === "text" && child.text !== undefined) {
          runs.push({
            bold: child.marks?.some((mark) => mark.type === "bold") ?? false,
            text: child.text,
          });
        }
      }
      paragraphs.push(runs);
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of richText.content as RichNode[]) visit(node);
  return paragraphs.length === 0 ? [[]] : paragraphs;
}

export function measureRichText(richText: { content: unknown[] }, options: MeasureOptions) {
  return measureParagraphs(paragraphsOf(richText), options);
}
