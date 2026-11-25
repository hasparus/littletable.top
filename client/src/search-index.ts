import type { TLPageId, TLShapeId } from "tldraw";

import MiniSearch, { type SearchResult } from "minisearch";

import { closeness, type Closeness, excerpt, type ExcerptPart, fold, oneLine } from "./search-text";

export type Point = { x: number; y: number };

export type SearchKind = "native" | "ocr" | "place";

export type SearchDoc = {
  /** Board-unique key combining the shape ID and the kind of text. */
  id: string;
  kind: SearchKind;
  page: TLPageId;
  /** For OCR only: line corners in decoded source-image pixels. */
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
  /** Matched terms in the index’s folded form. */
  terms: string[];
};

const boxOf = (region: readonly Point[]) => {
  const xs = region.map((point) => point.x);
  const ys = region.map((point) => point.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

function samePlace(a: readonly Point[], b: readonly Point[]): boolean {
  const p = boxOf(a);
  const q = boxOf(b);
  const x = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0));
  const y = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
  const smaller = Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0));
  return smaller > 0 && (x * y) / smaller >= 0.5;
}

const typos = (term: string) => (term.length <= 3 ? false : term.length <= 5 ? 1 : 2);

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

  /** Moves existing OCR lines to the new page and retains the first copy of duplicate non-OCR text. */
  setShape(shape: TLShapeId, page: TLPageId, docs: readonly SearchDoc[]): void {
    const entry = this.#shapes.get(shape);
    if (entry !== undefined) {
      this.#drop(entry.own);
      for (const id of entry.read) this.#docs.get(id)!.page = page;
    }
    const own = this.#add(docs, page);
    this.#shapes.set(shape, { own, page, read: entry?.read ?? [] });
  }

  /** Replaces one image’s OCR reading in full. Ignores shapes that are not indexed. */
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
    const short = fold(query).replaceAll(/[^\p{L}\p{N}]/gu, "").length < 2;
    return this.#mini.search(query, {
      boostDocument: (id: string) => (this.#docs.get(id)?.kind === "place" ? PLACE_BOOST : 1),
      combineWith,
      fuzzy: short ? false : typos,
      prefix: (_term, index, terms) => index === terms.length - 1,
    });
  }

  /** Ranks literal, folded, then fuzzy matches. Combines matches from the same shape or image region. */
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
