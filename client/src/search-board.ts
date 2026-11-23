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
import { fold } from "./search-text";

// How long the index waits after the board changes before it catches up,
// while the search sheet is open. Closed, it only notes what changed.
const SETTLE_MS = 250;

// What a shape says, as tldraw's own shape utils read it: rich text as
// plain text (notes, text, geo and arrow labels), a frame's name, a link's
// address, and the description it gives screen readers (an image's alt
// text, a bookmark's title and description), each once.
function textsOf(editor: Editor, shape: TLShape): string[] {
  const util = editor.getShapeUtil(shape);
  const texts: string[] = [];
  for (const text of [util.getAriaDescriptor(shape), util.getText(shape)]) {
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

// The board's search: an index of every page's text, built on first use
// and kept in step with the store from then on. It is this person's alone;
// nothing about it is written to the document.
export class BoardSearch {
  // Moves on whenever the index has caught up, so an open results list
  // asks again.
  readonly version = atom("board search version", 0);
  readonly #editor: Editor;
  #index: BoardIndex | null = null;
  readonly #changed = new Set<TLShapeId>();
  // Shapes that changed parent: their children may be on another page now.
  readonly #moved = new Set<TLShapeId>();
  readonly #gonePages = new Set<TLPageId>();
  readonly #changedAssets = new Set<TLAssetId>();
  readonly #shapesOfAsset = new Map<TLAssetId, Set<TLShapeId>>();
  #watching = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #stop: () => void;

  constructor(editor: Editor) {
    this.#editor = editor;
    this.#stop = editor.store.listen(({ changes }) => this.#note(changes), { scope: "document" });
  }

  dispose(): void {
    this.#stop();
    if (this.#timer !== null) clearTimeout(this.#timer);
  }

  // NOTE: runs on every change to the document, a keystroke in someone's
  // note among them, so it only notes ids; the work waits for the search.
  #note(changes: RecordsDiff<TLRecord>): void {
    if (this.#index === null) return;
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

  #schedule(): void {
    if (this.#watching === 0 || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#catchUp();
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

  #build(): BoardIndex {
    const started = performance.now();
    const index = new BoardIndex();
    for (const page of this.#editor.getPages()) {
      for (const id of this.#editor.getPageShapeIds(page)) {
        const shape = this.#editor.getShape(id);
        if (shape !== undefined) this.#put(index, shape);
      }
    }
    performance.measure("board-search:build", { start: started });
    return index;
  }

  #descendants(id: TLShapeId): TLShapeId[] {
    return this.#editor
      .getSortedChildIdsForParent(id)
      .flatMap((child) => [child, ...this.#descendants(child)]);
  }

  #catchUp(): void {
    const index = this.#index;
    if (index === null) return;
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
    for (const id of this.#changed) {
      const shape = this.#editor.getShape(id);
      if (shape === undefined) index.removeShape(id);
      else this.#put(index, shape);
    }
    this.#changed.clear();
    this.#moved.clear();
    this.#gonePages.clear();
    this.#changedAssets.clear();
    performance.measure("board-search:update", { start: started });
    this.version.update((version) => version + 1);
  }

  // While the search is open the index follows the board as it changes;
  // the first call builds it.
  watch(): () => void {
    if (this.#index === null) {
      this.#index = this.#build();
      this.version.update((version) => version + 1);
    } else this.#catchUp();
    this.#watching++;
    return () => {
      this.#watching--;
    };
  }

  search(query: string): Hit[] {
    return this.#index?.search(query) ?? [];
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
