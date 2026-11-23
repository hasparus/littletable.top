import type {
  TLArrowBinding,
  TLPage,
  TLPageId,
  TLParentId,
  TLRecord,
  TLShape,
  TLShapeId,
} from "@tldraw/tlschema";

// A board's document as the engine sees it: the records the room holds,
// with the batch's own writes laid over them. Each op works on it, and an
// op that fails rolls back to the mark taken before it, so a batch is
// written as one diff of whatever succeeded.

type Index = {
  bindings: Map<string, TLArrowBinding[]>;
  children: Map<string, TLShape[]>;
};

export class Doc {
  private readonly base: Map<string, TLRecord>;
  private readonly overlay = new Map<string, TLRecord | null>();
  private journal: { id: string; previous: TLRecord | null | undefined }[] = [];
  private index: Index | null = null;
  private readonly relied = new Set<string>();

  constructor(records: Iterable<TLRecord>) {
    this.base = new Map([...records].map((record) => [record.id, record]));
  }

  get<T extends TLRecord = TLRecord>(id: string): T | undefined {
    const written = this.overlay.get(id);
    if (written === null) return undefined;
    return (written ?? this.base.get(id)) as T | undefined;
  }

  shape(id: string): TLShape | undefined {
    const record = this.get(id);
    return record?.typeName === "shape" ? (record as TLShape) : undefined;
  }

  put(record: TLRecord): void {
    this.journal.push({ id: record.id, previous: this.overlay.get(record.id) });
    this.overlay.set(record.id, record);
    this.index = null;
  }

  remove(id: string): void {
    if (this.get(id) === undefined) return;
    this.journal.push({ id, previous: this.overlay.get(id) });
    this.overlay.set(id, null);
    this.index = null;
  }

  /** An op's answer rests on this record being as it is (and its parents). */
  depend(id: string): void {
    for (let at: string | undefined = id, depth = 0; at !== undefined && depth < 1_000; depth++) {
      this.relied.add(at);
      at = this.shape(at)?.parentId;
    }
  }

  /**
   * What must still hold in the room for this batch's writes to be right:
   * records it relied on or overwrites must be unchanged, ids it creates
   * must still be free.
   */
  preconditions(): { absent: string[]; unchanged: string[] } {
    const unchanged = new Set([...this.relied].filter((id) => this.base.has(id)));
    const absent: string[] = [];
    for (const [id, record] of this.overlay) {
      if (this.base.has(id)) unchanged.add(id);
      else if (record !== null) absent.push(id);
    }
    return { absent, unchanged: [...unchanged] };
  }

  mark(): number {
    return this.journal.length;
  }

  rollback(mark: number): void {
    while (this.journal.length > mark) {
      const { id, previous } = this.journal.pop()!;
      if (previous === undefined) this.overlay.delete(id);
      else this.overlay.set(id, previous);
    }
    this.index = null;
  }

  /** The records written or removed since a mark, as they now stand. */
  touchedSince(mark: number): { puts: TLRecord[]; removed: string[] } {
    const ids = new Set(this.journal.slice(mark).map(({ id }) => id));
    const puts: TLRecord[] = [];
    const removed: string[] = [];
    for (const id of ids) {
      const record = this.get(id);
      if (record === undefined) removed.push(id);
      else puts.push(record);
    }
    return { puts, removed };
  }

  /** The whole batch: records to write, and ids to delete from the room. */
  changes(): { deletes: string[]; puts: TLRecord[] } {
    const puts: TLRecord[] = [];
    const deletes: string[] = [];
    for (const [id, record] of this.overlay) {
      if (record === null) {
        if (this.base.has(id)) deletes.push(id);
      } else {
        puts.push(record);
      }
    }
    return { deletes, puts };
  }

  *records(): IterableIterator<TLRecord> {
    for (const [id, record] of this.base) {
      if (!this.overlay.has(id)) yield record;
    }
    for (const record of this.overlay.values()) if (record !== null) yield record;
  }

  pages(): TLPage[] {
    return [...this.records()]
      .filter((record): record is TLPage => record.typeName === "page")
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  }

  private built(): Index {
    if (this.index !== null) return this.index;
    const children = new Map<string, TLShape[]>();
    const bindings = new Map<string, TLArrowBinding[]>();
    for (const record of this.records()) {
      if (record.typeName === "shape") {
        const list = children.get(record.parentId) ?? [];
        list.push(record);
        children.set(record.parentId, list);
      } else if (record.typeName === "binding" && record.type === "arrow") {
        const binding = record as TLArrowBinding;
        for (const end of [binding.fromId, binding.toId]) {
          const list = bindings.get(end) ?? [];
          list.push(binding);
          bindings.set(end, list);
        }
      }
    }
    for (const list of children.values()) {
      list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    }
    this.index = { bindings, children };
    return this.index;
  }

  /** A parent's children, bottom to top. */
  children(parentId: TLParentId): TLShape[] {
    return this.built().children.get(parentId) ?? [];
  }

  /** Every shape on a page, parents before their children. */
  shapesOnPage(pageId: TLPageId): TLShape[] {
    const out: TLShape[] = [];
    const visit = (parentId: TLParentId) => {
      for (const child of this.children(parentId)) {
        out.push(child);
        visit(child.id);
      }
    };
    visit(pageId);
    return out;
  }

  descendants(id: TLShapeId): TLShape[] {
    const out: TLShape[] = [];
    const visit = (parentId: TLParentId) => {
      for (const child of this.children(parentId)) {
        out.push(child);
        visit(child.id);
      }
    };
    visit(id);
    return out;
  }

  bindingsOf(shapeId: string): TLArrowBinding[] {
    return this.built().bindings.get(shapeId) ?? [];
  }

  pageOf(shape: TLShape): TLPageId {
    let parent: TLParentId = shape.parentId;
    for (let depth = 0; depth < 1000; depth++) {
      if (parent.startsWith("page:")) return parent as TLPageId;
      const next = this.shape(parent);
      if (next === undefined) break;
      parent = next.parentId;
    }
    throw new Error(`${shape.id} is not on a page`);
  }
}
