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

import { imageQuadToPage } from "./image-quad";
import { placeName } from "./places";
import { BoardIndex, type Hit, type Point, type SearchDoc } from "./search-index";
import { fold, richTextWords } from "./search-text";

// How long the index waits after the board changes before it catches up.
const SETTLE_MS = 250;

// What a shape says, as tldraw's own shape utils read it: rich text as
// plain text (notes, text, geo and arrow labels), a frame's name, a link's
// address, and the description it gives screen readers (an image's alt
// text, a bookmark's title and description), each once. Rich text is read
// straight from its JSON (richTextWords), which is what getText reads too.
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

// Hands `run` the idle time the browser has to spare, as a function that
// says how many milliseconds are left. Safari has no requestIdleCallback.
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

// Shapes indexed in one idle slice however little time it has, so a busy
// page still gets there.
const MIN_SLICE = 25;

// The board's search: an index of every page's text, kept in step with
// the store. It is this person's alone; nothing about it is written to the
// document. Every shape starts out as changed, and the index catches up in
// the browser's idle time, slice by slice, so a search finds it ready and
// typing on the board never waits for it.
export class BoardSearch {
  // Moves on whenever the index has caught up, so an open results list
  // asks again.
  readonly version = atom("board search version", 0);
  readonly #editor: Editor;
  readonly #index = new BoardIndex();
  readonly #changed = new Set<TLShapeId>();
  // Shapes that changed parent: their children may be on another page now.
  readonly #moved = new Set<TLShapeId>();
  readonly #gonePages = new Set<TLPageId>();
  readonly #changedAssets = new Set<TLAssetId>();
  readonly #shapesOfAsset = new Map<TLAssetId, Set<TLShapeId>>();
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

  // NOTE: runs on every change to the document, a keystroke in someone's
  // note among them, so it only notes ids; the work waits for the board to
  // settle.
  #note(changes: RecordsDiff<TLRecord>): void {
    for (const record of Object.values(changes.added)) {
      if (record.typeName === "shape") this.#changed.add(record.id);
      else if (record.typeName === "asset") this.#changedAssets.add(record.id);
    }
    for (const [before, after] of Object.values(changes.updated)) {
      if (after.typeName === "shape" && before.typeName === "shape") {
        // Moving, turning or reordering a shape changes nothing it says.
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

  // Once the board has settled: at once while the search is open, else in
  // idle time.
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
    }
  }

  #descendants(id: TLShapeId): TLShapeId[] {
    return this.#editor
      .getSortedChildIdsForParent(id)
      .flatMap((child) => [child, ...this.#descendants(child)]);
  }

  // Brings the index up to the board, or as far as `left` allows.
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

  // While the search is open the index follows the board as it changes;
  // opening it finishes whatever the idle time has not.
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

  // Where a result is on its page now: the outline of its shape, turned as
  // the shape is, or for a line read off an image, that line where the
  // image now shows it. Null once the shape is gone.
  regionOf(doc: SearchDoc): Point[] | null {
    const shape = this.#editor.getShape(doc.shape);
    if (shape === undefined) return null;
    const transform = this.#editor.getShapePageTransform(shape);
    const outline = transform.applyToPoints(this.#editor.getShapeGeometry(shape).bounds.corners);
    if (doc.region === undefined || shape.type !== "image") return outline;
    const asset = this.#editor.getAsset(shape.props.assetId ?? ("" as TLAssetId));
    if (asset === undefined || asset.type !== "image") return outline;
    const line = imageQuadToPage(
      doc.region,
      { h: asset.props.h, w: asset.props.w },
      shape.props,
      transform,
    );
    // NOTE: a line the crop now hides still leads to its image.
    return line ?? outline;
  }
}
