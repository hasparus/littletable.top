import {
  atom,
  type Editor,
  type RecordsDiff,
  type TLAssetId,
  type TLPageId,
  type TLRecord,
  type TLShape,
  type TLShapeId,
} from "tldraw";

import type { TextResult } from "../../src/text-result";

import { imageQuadToPage } from "./image-quad";
import { placeName } from "./places";
import { BoardIndex, type Hit, type Point, type SearchDoc } from "./search-index";
import { fold, richTextWords } from "./search-text";
import { linesToIndex } from "./text-filter";

const SETTLE_MS = 250;

function textsOf(editor: Editor, shape: TLShape): string[] {
  const util = editor.getShapeUtil(shape);
  const { richText } = shape.props as { richText?: unknown };
  const own = richText === undefined ? util.getText(shape) : richTextWords(richText);
  const texts: string[] = [];
  for (const text of [util.getAriaDescriptor(shape), own]) {
    if (text === undefined || text.trim().length === 0) continue;
    if (texts.some((kept) => fold(kept) === fold(text))) continue;
    texts.push(text);
  }
  return texts;
}

function docsOf(editor: Editor, shape: TLShape, page: TLPageId): SearchDoc[] {
  const docs: SearchDoc[] = [];
  const name = placeName(shape);
  if (name !== null) {
    docs.push({ id: `${shape.id}#place`, kind: "place", page, shape: shape.id, text: name });
  }
  const texts = textsOf(editor, shape);
  if (texts.length > 0) {
    docs.push({
      id: `${shape.id}#text`,
      kind: "native",
      page,
      shape: shape.id,
      text: texts.join("\n"),
    });
  }
  return docs;
}

const assetOf = (shape: TLShape): TLAssetId | null => {
  const { assetId } = shape.props as { assetId?: unknown };
  return typeof assetId === "string" ? (assetId as TLAssetId) : null;
};

const HASH_IN_SRC = /\/files\/([0-9a-f]{64})$/u;

/** Returns the image bytes’ SHA-256 from its board file URL, or null for external images. */
export function imageHash(editor: Editor, asset: TLAssetId): string | null {
  const record = editor.getAsset(asset);
  if (record?.type !== "image" || typeof record.props.src !== "string") return null;
  return HASH_IN_SRC.exec(record.props.src)?.[1] ?? null;
}

function readDocs(shape: TLShapeId, page: TLPageId, readings: readonly TextResult[]): SearchDoc[] {
  return linesToIndex(readings).map((line, at) => ({
    id: `${shape}#ocr:${at}`,
    kind: "ocr",
    page,
    region: line.region,
    shape,
    text: line.text,
    words: line.words,
  }));
}

const tokens = (text: string) =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Page-space polygon. If a crop hides the OCR match, the polygon is the whole image. */
export type Found = { hidden: boolean; polygon: Point[] };

function whenIdle(run: (left: () => number) => void): () => void {
  if ("requestIdleCallback" in globalThis) {
    const handle = requestIdleCallback((deadline) => run(() => deadline.timeRemaining()), {
      timeout: 2000,
    });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(() => {
    const end = performance.now() + 8;
    run(() => end - performance.now());
  }, 50);
  return () => clearTimeout(handle);
}

const MIN_SLICE = 25;

/** Maintains a browser-local search index for every page of the board. */
export class BoardSearch {
  /** Advances whenever the index catches up, so an open result list can refresh. */
  readonly version = atom("board search version", 0);
  readonly #editor: Editor;
  readonly #index = new BoardIndex();
  readonly #changed = new Set<TLShapeId>();
  readonly #moved = new Set<TLShapeId>();
  readonly #gonePages = new Set<TLPageId>();
  readonly #changedAssets = new Set<TLAssetId>();
  readonly #shapesOfAsset = new Map<TLAssetId, Set<TLShapeId>>();
  readonly #readings = new Map<string, TextResult[]>();
  #watching = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #cancelIdle: (() => void) | null = null;
  readonly #stop: () => void;

  constructor(editor: Editor) {
    this.#editor = editor;
    this.#stop = editor.store.listen(({ changes }) => this.#note(changes), { scope: "document" });
    for (const page of editor.getPages()) {
      for (const id of editor.getPageShapeIds(page)) this.#changed.add(id);
    }
    this.#warm();
  }

  dispose(): void {
    this.#stop();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#cancelIdle?.();
  }

  #warm(): void {
    this.#cancelIdle = whenIdle((left) => {
      this.#catchUp(left);
      if (this.#changed.size > 0) this.#warm();
      else this.#cancelIdle = null;
    });
  }

  // WARNING: Runs on every document change, including keystrokes. Record IDs and defer indexing.
  #note(changes: RecordsDiff<TLRecord>): void {
    for (const record of Object.values(changes.added)) {
      if (record.typeName === "shape") this.#changed.add(record.id);
      else if (record.typeName === "asset") this.#changedAssets.add(record.id);
    }
    for (const [before, after] of Object.values(changes.updated)) {
      if (after.typeName === "shape" && before.typeName === "shape") {
        if (before.parentId !== after.parentId) this.#moved.add(after.id);
        else if (before.props === after.props && before.meta === after.meta) continue;
        this.#changed.add(after.id);
      } else if (after.typeName === "asset") this.#changedAssets.add(after.id);
    }
    for (const record of Object.values(changes.removed)) {
      if (record.typeName === "shape") this.#changed.add(record.id);
      else if (record.typeName === "page") this.#gonePages.add(record.id);
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#watching > 0) this.#catchUp();
      else if (this.#cancelIdle === null) this.#warm();
    }, SETTLE_MS);
  }

  #put(index: BoardIndex, shape: TLShape): void {
    const page = this.#editor.getAncestorPageId(shape);
    if (page === undefined) {
      index.removeShape(shape.id);
      return;
    }
    index.setShape(shape.id, page, docsOf(this.#editor, shape, page));
    const asset = assetOf(shape);
    if (asset !== null) {
      const shapes = this.#shapesOfAsset.get(asset) ?? new Set();
      shapes.add(shape.id);
      this.#shapesOfAsset.set(asset, shapes);
      const hash = shape.type === "image" ? imageHash(this.#editor, asset) : null;
      const readings = hash === null ? undefined : this.#readings.get(hash);
      if (readings !== undefined) index.setImageText(shape.id, readDocs(shape.id, page, readings));
    }
  }

  /** Replaces readings for every shape using these bytes, including shapes added later. */
  setImageReadings(hash: string, readings: readonly TextResult[]): void {
    this.#readings.set(hash, [...readings]);
    for (const [asset, shapes] of this.#shapesOfAsset) {
      if (imageHash(this.#editor, asset) !== hash) continue;
      for (const id of shapes) {
        const shape = this.#editor.getShape(id);
        const page = shape === undefined ? undefined : this.#editor.getAncestorPageId(shape);
        if (page !== undefined) this.#index.setImageText(id, readDocs(id, page, readings));
      }
    }
    this.version.update((version) => version + 1);
  }

  #descendants(id: TLShapeId): TLShapeId[] {
    return this.#editor
      .getSortedChildIdsForParent(id)
      .flatMap((child) => [child, ...this.#descendants(child)]);
  }

  #catchUp(left: () => number = () => Infinity): void {
    const index = this.#index;
    const work = this.#changed.size + this.#moved.size + this.#gonePages.size;
    if (work + this.#changedAssets.size === 0) return;
    const started = performance.now();
    for (const page of this.#gonePages) index.removePage(page);
    for (const id of this.#moved) {
      this.#changed.add(id);
      for (const child of this.#descendants(id)) this.#changed.add(child);
    }
    for (const asset of this.#changedAssets) {
      for (const id of this.#shapesOfAsset.get(asset) ?? []) this.#changed.add(id);
    }
    this.#moved.clear();
    this.#changedAssets.clear();
    let done = 0;
    for (const id of this.#changed) {
      if (done >= MIN_SLICE && left() <= 1) break;
      const shape = this.#editor.getShape(id);
      if (shape === undefined) index.removeShape(id);
      else this.#put(index, shape);
      this.#changed.delete(id);
      done++;
    }
    this.#gonePages.clear();
    performance.measure("board-search:update", { start: started });
    this.version.update((version) => version + 1);
  }

  /** Finishes indexing immediately and keeps the index current until the returned function is called. */
  watch(): () => void {
    this.#catchUp();
    this.#watching++;
    return () => {
      this.#watching--;
    };
  }

  search(query: string): Hit[] {
    return this.#index.search(query);
  }

  /** Returns the current outline of the matched shape or OCR words, or null if the shape is gone. */
  regionOf(hit: Pick<Hit, "doc" | "terms">): Found | null {
    const { doc } = hit;
    const shape = this.#editor.getShape(doc.shape);
    if (shape === undefined) return null;
    const transform = this.#editor.getShapePageTransform(shape);
    const outline = transform.applyToPoints(this.#editor.getShapeGeometry(shape).bounds.corners);
    if (doc.region === undefined || shape.type !== "image")
      return { hidden: false, polygon: outline };
    const asset = this.#editor.getAsset(shape.props.assetId ?? ("" as TLAssetId));
    if (asset?.type !== "image") return { hidden: false, polygon: outline };
    const matched = (doc.words ?? []).filter((word) =>
      tokens(word.text).some((token) => hit.terms.includes(token)),
    );
    const regions = matched.length > 0 ? matched.map((word) => word.region) : [doc.region];
    // WARNING: tldraw can round asset dimensions. Use the decoded size to project OCR coordinates.
    const read = this.#readings.get(imageHash(this.#editor, asset.id) ?? "")?.[0]?.image;
    const size =
      read === undefined
        ? { h: asset.props.h, w: asset.props.w }
        : { h: read.height, w: read.width };
    const shown = regions.flatMap(
      (region) => imageQuadToPage(region, size, shape.props, transform) ?? [],
    );
    if (shown.length === 0) return { hidden: true, polygon: outline };
    return { hidden: false, polygon: regions.length === 1 ? shown : hull(shown) };
  }
}

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function hullHalf(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    while (out.length >= 2 && cross(out.at(-2)!, out.at(-1)!, point) <= 0) out.pop();
    out.push(point);
  }
  return out.slice(0, -1);
}

function hull(points: readonly Point[]): Point[] {
  const sorted = points.toSorted((a, b) => a.x - b.x || a.y - b.y);
  return [...hullHalf(sorted), ...hullHalf(sorted.toReversed())];
}
