import type { TLPageId, TLShapeId } from "tldraw";

import MiniSearch, { type SearchResult } from "minisearch";

import { closeness, type Closeness, excerpt, type ExcerptPart, fold, oneLine } from "./search-text";

export type Point = { x: number; y: number };

export type SearchKind = "native" | "ocr" | "place";

export type SearchDoc = {
  // Unique on the board: the shape's id and what the text is of it.
  id: string;
  kind: SearchKind;
  page: TLPageId;
  // Only for "ocr": the line's corners in the source image's pixels, which
  // imageQuadToPage turns into page coordinates for the shape as it lies
  // now, and each word's, so a hit can show just the words it matched.
  region?: readonly Point[];
  shape: TLShapeId;
  text: string;
  words?: readonly { region: readonly Point[]; text: string }[];
};

export type Hit = {
  closeness: Closeness;
  doc: SearchDoc;
  excerpt: ExcerptPart[];
  score: number;
  // The document's words that matched, folded as the index keeps them.
  terms: string[];
};

const boxOf = (region: readonly Point[]) => {
  const xs = region.map((point) => point.x);
  const ys = region.map((point) => point.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

// Two lines read off the same place of an image: one covers most of the
// other (two engines' readings, a word and the line it is part of).
function samePlace(a: readonly Point[], b: readonly Point[]): boolean {
  const p = boxOf(a);
  const q = boxOf(b);
  const x = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0));
  const y = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
  const smaller = Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0));
  return smaller > 0 && (x * y) / smaller >= 0.5;
}

// Typos forgiven by word length: none up to three letters, where one edit
// already reaches most other words, one in four or five, two from six. The
// index counts swapped letters ("tavren") as two edits.
const typos = (term: string) => (term.length <= 3 ? false : term.length <= 5 ? 1 : 2);

// Places are how people move around the board, so a place that matches
// stands ahead of text that matches as well.
const PLACE_BOOST = 3;
export const MAX_HITS = 50;

type Entry = { own: string[]; page: TLPageId; read: string[] };

export class BoardIndex {
  readonly #docs = new Map<string, SearchDoc>();
  readonly #shapes = new Map<TLShapeId, Entry>();
  readonly #mini = new MiniSearch<SearchDoc>({
    fields: ["text"],
    processTerm: (term) => fold(term),
    storeFields: [],
  });

  get size(): number {
    return this.#docs.size;
  }

  #drop(ids: readonly string[]): void {
    for (const id of ids) {
      this.#docs.delete(id);
      this.#mini.discard(id);
    }
  }

  #add(docs: readonly SearchDoc[], page: TLPageId): string[] {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const doc of docs) {
      const text = oneLine(doc.text);
      const key = fold(text);
      if (key.length === 0) continue;
      if (doc.region === undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const stored = { ...doc, page, text };
      this.#docs.set(doc.id, stored);
      this.#mini.add(stored);
      kept.push(doc.id);
    }
    return kept;
  }

  // OCR lines follow a shape to its new page. Duplicate non-OCR text
  // keeps only the first document.
  setShape(shape: TLShapeId, page: TLPageId, docs: readonly SearchDoc[]): void {
    const entry = this.#shapes.get(shape);
    if (entry !== undefined) {
      this.#drop(entry.own);
      for (const id of entry.read) this.#docs.get(id)!.page = page;
    }
    const own = this.#add(docs, page);
    this.#shapes.set(shape, { own, page, read: entry?.read ?? [] });
  }

  // Replaces every line read off an image shape, as one reading of it (a
  // better one may come later and replace it). A shape the index does not
  // hold, gone or not yet seen, takes none.
  setImageText(shape: TLShapeId, docs: readonly SearchDoc[]): void {
    const entry = this.#shapes.get(shape);
    if (entry === undefined) return;
    this.#drop(entry.read);
    entry.read = this.#add(docs, entry.page);
  }

  removeShape(shape: TLShapeId): void {
    const entry = this.#shapes.get(shape);
    if (entry === undefined) return;
    this.#drop([...entry.own, ...entry.read]);
    this.#shapes.delete(shape);
  }

  removePage(page: TLPageId): void {
    for (const [shape, entry] of this.#shapes) if (entry.page === page) this.removeShape(shape);
  }

  #run(query: string, combineWith: "AND" | "OR"): SearchResult[] {
    // NOTE: one letter forgives nothing and only starts words; anything
    // more forgiving would match most of the board.
    const short = fold(query).replaceAll(/[^\p{L}\p{N}]/gu, "").length < 2;
    return this.#mini.search(query, {
      boostDocument: (id: string) => (this.#docs.get(id)?.kind === "place" ? PLACE_BOOST : 1),
      combineWith,
      fuzzy: short ? false : typos,
      // NOTE: only the word being typed is a prefix; the words before it
      // are finished.
      prefix: (_term, index, terms) => index === terms.length - 1,
    });
  }

  // Results favor text that holds the query as typed, then
  // folded, then only through prefixes and typos; within each, the index's
  // own relevance with places boosted. A shape's text and its place name
  // are one result, not two, and so are lines read off the same place of
  // an image. Several words must all match, unless no document has them
  // all.
  search(raw: string): Hit[] {
    const query = oneLine(raw);
    if (fold(query).replaceAll(/[^\p{L}\p{N}]/gu, "").length === 0) return [];
    let results = this.#run(query, "AND");
    if (results.length === 0 && query.includes(" ")) results = this.#run(query, "OR");
    const hits = results.flatMap((result): Hit[] => {
      const doc = this.#docs.get(result.id as string);
      if (doc === undefined) return [];
      return [
        {
          closeness: closeness(query, doc.text),
          doc,
          excerpt: excerpt(doc.text, query, result.terms),
          score: result.score,
          terms: result.terms,
        },
      ];
    });
    hits.sort((a, b) => b.closeness - a.closeness || b.score - a.score);
    const shown = new Set<TLShapeId>();
    const places: SearchDoc[] = [];
    return hits
      .filter(({ doc }) => {
        if (doc.kind === "ocr") {
          const region = doc.region ?? [];
          const seen = places.some(
            (other) => other.shape === doc.shape && samePlace(other.region ?? [], region),
          );
          if (!seen) places.push(doc);
          return !seen;
        }
        if (shown.has(doc.shape)) return false;
        shown.add(doc.shape);
        return true;
      })
      .slice(0, MAX_HITS);
  }
}
