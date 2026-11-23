// Folding, matching and excerpts for the board's search. Everything here is
// pure text, so the index and the results list agree on what matched.

// Folds one UTF-16 unit for matching: lower case, Polish ł to l, other
// diacritics dropped (ż, ó, ę, á, ü…). A unit that would fold to more or
// fewer than one unit (İ, ß, a lone surrogate) is only lower-cased or kept,
// so a folded text is exactly as long as its source and a position found in
// one is the same position in the other.
function foldUnit(unit: string): string {
  const lower = unit.toLowerCase();
  if (lower === "ł") return "l";
  const bare = lower.normalize("NFD").replaceAll(/\p{M}/gu, "");
  if (bare.length === 1) return bare;
  return lower.length === 1 ? lower : unit;
}

export function fold(text: string): string {
  let folded = "";
  // NOTE: by UTF-16 unit, not by code point (for…of), so lengths stay equal.
  for (let index = 0; index < text.length; index++) folded += foldUnit(text.charAt(index));
  return folded;
}

function lowerAligned(text: string): string {
  let lower = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text.charAt(index);
    const down = unit.toLowerCase();
    lower += down.length === 1 ? down : unit;
  }
  return lower;
}

type RichNode = { content?: unknown; text?: unknown; type?: unknown };

// The words of a tldraw rich text (a TipTap document), blocks and line
// breaks as spaces. tldraw's own renderPlaintextFromRichText runs TipTap's
// generateText, about 0.3 ms a shape, which is most of a second on a
// large board; this walk reads the same words from the JSON directly.
export function richTextWords(richText: unknown): string {
  const words: string[] = [];
  const walk = (node: RichNode) => {
    if (typeof node.text === "string") words.push(node.text);
    else if (node.type === "hardBreak") words.push(" ");
    if (!Array.isArray(node.content)) return;
    for (const child of node.content as RichNode[]) walk(child);
    words.push(" ");
  };
  if (typeof richText === "object" && richText !== null) walk(richText as RichNode);
  return oneLine(words.join(""));
}

// Text as the results list shows it: one line, single spaces.
export const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const WORD = /[\p{L}\p{N}]+/gu;
const isWordUnit = (unit: string | undefined) => unit !== undefined && /[\p{L}\p{N}]/u.test(unit);

// Where `needle` starts a word in `haystack`, or -1.
function wordStart(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isWordUnit(haystack[at - 1])) return at;
  }
  return -1;
}

// How closely a result's text holds the query, best first: the query as
// typed, diacritics and all (3), the query once both are folded (2), or
// only the index's prefix and typo matching (1). Case never counts.
export type Closeness = 1 | 2 | 3;

export function closeness(query: string, text: string): Closeness {
  const typed = oneLine(query);
  if (wordStart(lowerAligned(text), lowerAligned(typed)) !== -1) return 3;
  if (wordStart(fold(text), fold(typed)) !== -1) return 2;
  return 1;
}

export type ExcerptPart = { mark: boolean; text: string };

// Up to about this many characters of a long text show in a result.
export const EXCERPT_LENGTH = 90;
// How much of the text before the first match stays in view.
const LEAD = 28;

type Span = { end: number; start: number };

// What to emphasise: the whole query where the text holds it at the start
// of a word, else every whole word the index matched (its terms are folded
// words, typos and prefixes already resolved to the word on the board).
function spansOf(text: string, query: string, terms: readonly string[]): Span[] {
  const folded = fold(text);
  const phrase = fold(oneLine(query));
  const at = wordStart(folded, phrase);
  if (at !== -1) return [{ end: at + phrase.length, start: at }];
  const wanted = new Set(terms);
  return [...folded.matchAll(WORD)]
    .filter((word) => wanted.has(word[0]))
    .map((word) => ({ end: word.index + word[0].length, start: word.index }));
}

// A window of a result's text around its first match, cut at word edges,
// with the matches marked; a short text shows whole.
export function excerpt(source: string, query: string, terms: readonly string[]): ExcerptPart[] {
  const text = oneLine(source);
  const spans = spansOf(text, query, terms);
  let start = 0;
  let end = text.length;
  if (text.length > EXCERPT_LENGTH) {
    const anchor = spans[0]?.start ?? 0;
    start = Math.max(0, Math.min(anchor - LEAD, text.length - EXCERPT_LENGTH));
    if (start > 0) {
      const space = text.indexOf(" ", start - 1);
      start = space === -1 || space >= anchor ? start : space + 1;
    }
    end = Math.min(text.length, start + EXCERPT_LENGTH);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      const covered = spans[0] === undefined ? start : spans[0].end;
      end = space > covered ? space : Math.max(end, covered);
    }
  }
  const parts: ExcerptPart[] = [];
  const push = (from: number, to: number, mark: boolean) => {
    if (to > from) parts.push({ mark, text: text.slice(from, to) });
  };
  if (start > 0) parts.push({ mark: false, text: "…" });
  let at = start;
  for (const span of spans) {
    const from = Math.max(span.start, at);
    const to = Math.min(span.end, end);
    if (to <= from) continue;
    push(at, from, false);
    push(from, to, true);
    at = to;
  }
  push(at, end, false);
  if (end < text.length) parts.push({ mark: false, text: "…" });
  return parts;
}
