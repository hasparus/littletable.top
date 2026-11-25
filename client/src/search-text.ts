function foldUnit(unit: string): string {
  const lower = unit.toLowerCase();
  if (lower === "ł") return "l";
  const bare = lower.normalize("NFD").replaceAll(/\p{M}/gu, "");
  if (bare.length === 1) return bare;
  return lower.length === 1 ? lower : unit;
}

export function fold(text: string): string {
  let folded = "";
  // WARNING: Iterate UTF-16 units, not code points, to preserve the source offsets.
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

/** Extracts rich-text words directly from TipTap JSON, treating block and line breaks as spaces. */
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

export const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const WORD = /[\p{L}\p{N}]+/gu;
const isWordUnit = (unit: string | undefined) => unit !== undefined && /[\p{L}\p{N}]/u.test(unit);

function wordStart(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isWordUnit(haystack[at - 1])) return at;
  }
  return -1;
}

/** Match priority: original spelling, folded spelling, or prefix and typo match. Case never counts. */
export type Closeness = 1 | 2 | 3;

export function closeness(query: string, text: string): Closeness {
  const typed = oneLine(query);
  if (wordStart(lowerAligned(text), lowerAligned(typed)) !== -1) return 3;
  if (wordStart(fold(text), fold(typed)) !== -1) return 2;
  return 1;
}

export type ExcerptPart = { mark: boolean; text: string };

export const EXCERPT_LENGTH = 90;
const LEAD = 28;

type Span = { end: number; start: number };

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

/** Returns a word-aligned excerpt with matches marked. Short text is returned whole. */
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
