import {
  createShapeId,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDrawShape,
  type TLGeoShape,
  type TLLineShape,
  type TLNoteShape,
  type TLPageId,
  type TLParentId,
  type TLRecord,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLTextShape,
  toRichText,
} from "@tldraw/tlschema";
import { getIndexAbove, getIndexBetween, getIndices, type IndexKey } from "@tldraw/utils";

import type { Doc } from "../../ops/doc";

import {
  apply,
  arrowPath,
  localBounds,
  pageBounds,
  pageToLocal,
  pageTransform,
  type Box as Rect,
  toParentSpace,
  type Vec,
} from "../../ops/geometry";
import { textOf, validate } from "../../ops/records";
import { type FontFamily, measureParagraphs } from "../../ops/text/measure";
import {
  geoLabelSize,
  isEmptyRichText,
  noteSizing,
  type SizeStyle,
  textShapeSize,
} from "../../ops/text/sizing";
import { geoHitTest } from "./geo-outline";

// A stand-in for tldraw's Editor: exactly the part of its surface that
// tldraw's canvas-ops engine calls, over a snapshot of a board's records
// instead of a live store in a browser. Reads come from our geometry and
// text measurer; writes do what the editor's own createShapes, updateShapes,
// deleteShapes and arrow binding util would have done to the records
// (default props, frame parenting, label sizing, arrow order), so the
// records that come out are the ones a browser would have produced.

/** tldraw's default `maxShapesPerPage`: createShape does nothing beyond it. */
export const MAX_SHAPES_PER_PAGE = 4000;

export class Box {
  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
  ) {}

  static from({ h, w, x, y }: Rect): Box {
    return new Box(x, y, w, h);
  }

  get minX() {
    return this.x;
  }
  get minY() {
    return this.y;
  }
  get maxX() {
    return this.x + this.w;
  }
  get maxY() {
    return this.y + this.h;
  }
  get midX() {
    return this.x + this.w / 2;
  }
  get midY() {
    return this.y + this.h / 2;
  }
  get center(): Vec {
    return { x: this.midX, y: this.midY };
  }
}

type Geometry = {
  bounds: Box;
  hitTestPoint(point: Vec, margin?: number, hitInside?: boolean): boolean;
  isClosed: boolean;
};

type Transform = { applyToPoint(point: Vec): Vec; rotation(): number };

type Partial = TLShapePartial & { parentId?: TLParentId };
type IdOrShape = TLShape | TLShapeId | { id: TLShapeId };

type MeasureTextOptions = {
  fontFamily: string;
  fontSize: number;
  fontStyle?: string;
  fontWeight?: string;
  lineHeight: number;
  maxWidth: number | null;
  minWidth?: number | null;
  padding?: string;
};

const idOf = (value: IdOrShape): TLShapeId => (typeof value === "string" ? value : value.id);

const DEFAULT_PROPS: Record<string, () => Record<string, unknown>> = {
  arrow: () => ({
    arrowheadEnd: "arrow",
    arrowheadStart: "none",
    bend: 0,
    color: "black",
    dash: "draw",
    elbowMidPoint: 0.5,
    end: { x: 2, y: 0 },
    fill: "none",
    font: "draw",
    kind: "arc",
    labelColor: "black",
    labelPosition: 0.5,
    richText: toRichText(""),
    scale: 1,
    size: "m",
    start: { x: 0, y: 0 },
  }),
  draw: () => ({
    color: "black",
    dash: "draw",
    fill: "none",
    isClosed: false,
    isComplete: false,
    isPen: false,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    segments: [],
    size: "m",
  }),
  frame: () => ({ color: "black", h: 90, name: "", w: 160 }),
  geo: () => ({
    align: "middle",
    color: "black",
    dash: "draw",
    fill: "none",
    flipX: false,
    flipY: false,
    font: "draw",
    geo: "rectangle",
    growY: 0,
    h: 100,
    labelColor: "black",
    richText: toRichText(""),
    scale: 1,
    size: "m",
    url: "",
    verticalAlign: "middle",
    w: 100,
  }),
  line: () => {
    const [start, end] = getIndices(2) as [IndexKey, IndexKey];
    return {
      color: "black",
      dash: "draw",
      points: {
        [end]: { id: end, index: end, x: 0.1, y: 0.1 },
        [start]: { id: start, index: start, x: 0, y: 0 },
      },
      scale: 1,
      size: "m",
      spline: "line",
    };
  },
  note: () => ({
    align: "middle",
    color: "black",
    font: "draw",
    fontSizeAdjustment: 1,
    growY: 0,
    labelColor: "black",
    richText: toRichText(""),
    scale: 1,
    size: "m",
    textLastEditedBy: null,
    url: "",
    verticalAlign: "middle",
  }),
  text: () => ({
    autoSize: true,
    color: "black",
    font: "draw",
    richText: toRichText(""),
    scale: 1,
    size: "m",
    textAlign: "start",
    w: 8,
  }),
};

// tldraw's geo util: what a label of this size needs before the shape is "small".
const MIN_SIZE_WITH_LABEL = 51;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class StandInEditor {
  private marks = new Map<string, number>();
  private undoable: number[] = [];
  private redoable: { puts: TLRecord[]; removed: string[] }[] = [];
  private selected: TLShapeId[];
  private readonly userId: string | null;

  readonly textMeasure = {
    // tldraw measures plain text as one paragraph per line.
    measureText: (text: string, options: MeasureTextOptions) => {
      const family = (["draw", "sans", "serif", "mono"] as const).find((name) =>
        options.fontFamily.includes(`tldraw_${name}`),
      );
      const measured = measureParagraphs(
        text.split("\n").map((line) => [{ bold: false, text: line === "" ? " " : line }]),
        {
          family: family ?? "draw",
          fontSize: options.fontSize,
          lineHeight: options.lineHeight,
          maxWidth: options.maxWidth,
          minWidth: options.minWidth,
        },
      );
      return { h: measured.h, scrollWidth: measured.scrollWidth, w: measured.w, x: 0, y: 0 };
    },
  };

  constructor(
    readonly doc: Doc,
    private readonly pageId: TLPageId,
    options: { selected?: TLShapeId[]; userId?: string | null } = {},
  ) {
    this.selected = options.selected ?? [];
    this.userId = options.userId ?? null;
  }

  // --- reading -------------------------------------------------------------

  private lookup(value: IdOrShape): TLShape | undefined {
    const record = this.doc.shape(idOf(value));
    return record !== undefined && this.doc.pageOf(record) === this.pageId ? record : undefined;
  }

  /**
   * NOTE: a lookup by id is how the engine names the shapes an op is about,
   * so it is what the batch is recorded as resting on (the conflict model in
   * docs/mcp-design.md); page-wide scans go through other calls and are not.
   */
  getShape<T extends TLShape = TLShape>(value: IdOrShape): T | undefined {
    const shape = this.lookup(value);
    if (shape !== undefined && typeof value === "string") this.doc.depend(shape.id);
    return shape as T | undefined;
  }

  hasRecord(id: string) {
    return this.doc.get(id) !== undefined;
  }

  getCurrentPageId(): TLPageId {
    return this.pageId;
  }

  getCurrentPageShapesSorted(): TLShape[] {
    return this.doc.shapesOnPage(this.pageId);
  }

  getCurrentPageShapes(): TLShape[] {
    return this.doc.shapesOnPage(this.pageId);
  }

  getCurrentPageShapeIds(): Set<TLShapeId> {
    return new Set(this.doc.shapesOnPage(this.pageId).map((shape) => shape.id));
  }

  getShapePageBounds(value: IdOrShape): Box | undefined {
    const shape = this.lookup(value);
    return shape === undefined ? undefined : Box.from(pageBounds(this.doc, shape));
  }

  getShapePageTransform(value: IdOrShape): Transform {
    const shape = this.lookup(value);
    const matrix = shape === undefined ? null : pageTransform(this.doc, shape);
    return {
      applyToPoint: (point) => (matrix === null ? point : apply(matrix, point)),
      rotation: () => (matrix === null ? 0 : Math.atan2(matrix[1], matrix[0])),
    };
  }

  getShapeGeometry(value: IdOrShape): Geometry {
    const shape = this.lookup(value)!;
    const bounds = Box.from(localBounds(this.doc, shape));
    const closed = !["arrow", "line"].includes(shape.type);
    return {
      bounds,
      hitTestPoint: (point, margin = 0, hitInside = false) => {
        if (shape.type === "geo") return geoHitTest(shape as TLGeoShape, point, margin, hitInside);
        return (
          hitInside &&
          point.x >= bounds.x - margin &&
          point.x <= bounds.maxX + margin &&
          point.y >= bounds.y - margin &&
          point.y <= bounds.maxY + margin
        );
      },
      isClosed: closed,
    };
  }

  getShapeUtil(_shape: IdOrShape) {
    return { getText: (shape: TLShape): string | undefined => textOf(shape) || undefined };
  }

  isShapeOrAncestorLocked(value: IdOrShape): boolean {
    let shape = this.lookup(value);
    for (let depth = 0; shape !== undefined && depth < 1000; depth++) {
      if (shape.isLocked) return true;
      shape = this.doc.shape(shape.parentId);
    }
    return false;
  }

  getShapeAndDescendantIds(ids: TLShapeId[]): Set<TLShapeId> {
    const out = new Set<TLShapeId>();
    for (const id of ids) {
      if (this.lookup(id) === undefined) continue;
      out.add(id);
      for (const child of this.doc.descendants(id)) out.add(child.id);
    }
    return out;
  }

  getSelectedShapeIds(): TLShapeId[] {
    return this.selected.filter((id) => this.lookup(id) !== undefined);
  }

  getBindingsFromShape(value: IdOrShape, type: string): TLArrowBinding[] {
    const id = idOf(value);
    return this.doc
      .bindingsOf(id)
      .filter((binding) => binding.fromId === id && binding.type === type);
  }

  // --- history -------------------------------------------------------------

  markHistoryStoppingPoint(name = "mark"): string {
    const id = `${name}:${this.marks.size}`;
    this.marks.set(id, this.doc.mark());
    return id;
  }

  bailToMark(id: string): this {
    const mark = this.marks.get(id);
    if (mark !== undefined) this.doc.rollback(mark);
    return this;
  }

  // NOTE: the whole batch is one commit to the room, so there is nothing to
  // squash; the mark is kept as the one step `undo` goes back to.
  squashToMark(id: string): this {
    const mark = this.marks.get(id);
    if (mark !== undefined) this.undoable.push(mark);
    return this;
  }

  /** Takes back the last batch, as one step. */
  undo(): this {
    const mark = this.undoable.pop();
    if (mark === undefined) return this;
    this.redoable.push(this.doc.touchedSince(mark));
    this.doc.rollback(mark);
    return this;
  }

  redo(): this {
    const again = this.redoable.pop();
    if (again === undefined) return this;
    this.undoable.push(this.doc.mark());
    for (const record of again.puts) this.doc.put(record);
    for (const id of again.removed) this.doc.remove(id);
    return this;
  }

  run(body: () => void, _options?: unknown): this {
    body();
    return this;
  }

  // --- writing -------------------------------------------------------------

  private put(record: TLRecord) {
    validate(record);
    this.doc.put(record);
  }

  // As Editor.createShapes: a positioned shape with no parent lands in the
  // topmost frame under its point.
  private parentAt(point: Vec, type: string): TLParentId {
    if (type === "frame") return this.pageId;
    const shapes = this.getCurrentPageShapesSorted();
    for (let index = shapes.length - 1; index >= 0; index--) {
      const candidate = shapes[index]!;
      if (candidate.type !== "frame") continue;
      const local = apply(pageToLocal(this.doc, candidate), point);
      const { h, w } = candidate.props as { h: number; w: number };
      if (local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h) return candidate.id;
    }
    return this.pageId;
  }

  createShape<T extends TLShape = TLShape>(partial: Partial | TLShapePartial<T>): this {
    const given = partial as Partial;
    if (given.id !== undefined && this.hasRecord(given.id)) {
      throw new Error(`Shape "${given.id.slice("shape:".length)}" already exists; use a new id`);
    }
    if (this.getCurrentPageShapeIds().size + 1 > MAX_SHAPES_PER_PAGE) return this;
    const defaults = DEFAULT_PROPS[given.type];
    if (defaults === undefined) throw new Error(`This board cannot create a ${given.type} shape`);
    let { x = 0, y = 0 } = given;
    let rotation = given.rotation ?? 0;
    let { parentId } = given;
    if (parentId === undefined || this.doc.get(parentId) === undefined) {
      const positioned = given.x !== undefined && given.y !== undefined;
      parentId = positioned ? this.parentAt({ x, y }, given.type) : this.pageId;
      if (parentId !== this.pageId) {
        const parent = this.doc.shape(parentId)!;
        ({ x, y } = apply(toParentSpace(this.doc, parentId), { x, y }));
        rotation -= Math.atan2(...this.rotationOf(parent));
      }
    }
    const siblings = this.doc.children(parentId);
    let shape = {
      id: given.id ?? createShapeId(),
      index: given.index ?? getIndexAbove(siblings.at(-1)?.index ?? null),
      isLocked: given.isLocked ?? false,
      meta: given.meta ?? {},
      opacity: given.opacity ?? 1,
      parentId,
      props: { ...defaults(), ...(given.props as object | undefined) },
      rotation,
      type: given.type,
      typeName: "shape",
      x,
      y,
    } as unknown as TLShape;
    shape = this.beforeCreate(shape);
    this.put(shape);
    return this;
  }

  private rotationOf(shape: TLShape): [number, number] {
    const matrix = pageTransform(this.doc, shape);
    return [matrix[1], matrix[0]];
  }

  // GeoShapeUtil.onBeforeCreate and NoteShapeUtil.onBeforeCreate.
  private beforeCreate(shape: TLShape): TLShape {
    if (shape.type === "geo") {
      const { props } = shape as TLGeoShape;
      if (isEmptyRichText(props.richText)) return withProps(shape, { growY: 0 });
      const label = this.geoLabel(props);
      const h = props.h / props.scale;
      if (label.h > h) return withProps(shape, { growY: (label.h - h) * props.scale });
      return props.growY > 0 ? withProps(shape, { growY: 0 }) : shape;
    }
    if (shape.type === "note") return this.noteAdjusted(shape as TLNoteShape);
    return shape;
  }

  private geoLabel(props: TLGeoShape["props"]) {
    return geoLabelSize(props.richText, {
      font: props.font as FontFamily,
      size: props.size as SizeStyle,
      w: props.w / props.scale,
    });
  }

  private noteAdjusted(note: TLNoteShape): TLShape {
    const { fontSizeAdjustment, growY } = noteSizing(note.props.richText, {
      font: note.props.font as FontFamily,
      size: note.props.size as SizeStyle,
    });
    return withProps(note, { fontSizeAdjustment, growY });
  }

  // The shape utils' onBeforeUpdate: what tldraw does to a record when its
  // text, font or size style changes.
  private beforeUpdate(prev: TLShape, next: TLShape): TLShape {
    if (next.type === "geo") {
      const before = (prev as TLGeoShape).props;
      const after = (next as TLGeoShape).props;
      if (
        sameJson(before.richText, after.richText) &&
        before.font === after.font &&
        before.size === after.size
      ) {
        return next;
      }
      const wasEmpty = isEmptyRichText(before.richText);
      const isEmpty = isEmptyRichText(after.richText);
      if (wasEmpty && isEmpty) return next;
      if (isEmpty) return after.growY === 0 ? next : withProps(next, { growY: 0 });
      const { scale } = after;
      const label = this.geoLabel(after);
      const prevW = before.w / before.scale;
      const prevH = before.h / before.scale;
      const prevGrowY = before.growY / before.scale;
      if (wasEmpty) {
        let w = Math.max(prevW, label.w);
        let h = Math.max(prevH, label.h);
        if (prevW < MIN_SIZE_WITH_LABEL && prevH < MIN_SIZE_WITH_LABEL) {
          w = h = Math.max(w, h, MIN_SIZE_WITH_LABEL);
        }
        return withProps(next, { growY: 0, h: h * scale, w: w * scale });
      }
      const nextW = after.w / scale;
      const widen = label.w > nextW;
      const growY = label.h > prevH ? label.h - prevH : prevGrowY > 0 ? 0 : null;
      if (growY === null && !widen) return next;
      return withProps(next, {
        growY: (growY ?? prevGrowY) * scale,
        w: Math.max(nextW, label.w) * scale,
      });
    }
    if (next.type === "note") {
      const before = (prev as TLNoteShape).props;
      const after = (next as TLNoteShape).props;
      const textChanged = !sameJson(before.richText, after.richText);
      if (!textChanged && before.font === after.font && before.size === after.size) return next;
      const stamped = textChanged
        ? withProps(next, {
            textLastEditedBy: isEmptyRichText(after.richText) ? null : this.userId,
          })
        : next;
      return this.noteAdjusted(stamped as TLNoteShape);
    }
    if (next.type === "text") {
      const before = (prev as TLTextShape).props;
      const after = (next as TLTextShape).props;
      if (!after.autoSize) return next;
      const styleChanged =
        before.size !== after.size ||
        before.textAlign !== after.textAlign ||
        before.font !== after.font ||
        (before.scale !== 1 && after.scale === 1);
      const textChanged = !sameJson(before.richText, after.richText);
      if (!styleChanged && !textChanged) return next;
      const a = this.textSize(before);
      const b = this.textSize(after);
      const [wA, hA] = [a.w * before.scale, a.h * before.scale];
      const [wB, hB] = [b.w * after.scale, b.h * after.scale];
      let delta: Vec | null = null;
      if (after.textAlign === "middle") {
        delta = { x: (wB - wA) / 2, y: textChanged ? 0 : (hB - hA) / 2 };
      } else if (after.textAlign === "end") {
        delta = { x: wB - wA, y: textChanged ? 0 : (hB - hA) / 2 };
      } else if (!textChanged) {
        delta = { x: 0, y: (hB - hA) / 2 };
      }
      if (delta === null) return withProps(next, { w: wB });
      const cos = Math.cos(next.rotation);
      const sin = Math.sin(next.rotation);
      return {
        ...withProps(next, { w: wB }),
        x: next.x - (delta.x * cos - delta.y * sin),
        y: next.y - (delta.x * sin + delta.y * cos),
      } as TLShape;
    }
    return next;
  }

  private textSize(props: TLTextShape["props"]) {
    return textShapeSize(props.richText as TLRichText, {
      autoSize: props.autoSize,
      font: props.font as FontFamily,
      size: props.size as SizeStyle,
      w: props.w,
    });
  }

  updateShape(partial: TLShapePartial): this {
    const prev = this.lookup(partial.id);
    if (prev === undefined || this.isShapeOrAncestorLocked(prev)) return this;
    const { meta, props, ...rest } = partial as TLShapePartial & { meta?: object; props?: object };
    const merged = {
      ...prev,
      ...rest,
      meta: meta === undefined ? prev.meta : { ...prev.meta, ...meta },
      props: props === undefined ? prev.props : { ...prev.props, ...props },
    } as TLShape;
    this.put(this.beforeUpdate(prev, merged));
    return this;
  }

  deleteShapes(values: IdOrShape[]): this {
    const doomed = this.getShapeAndDescendantIds(
      values.map(idOf).filter((id) => !this.isShapeOrAncestorLocked(id)),
    );
    for (const id of doomed) {
      for (const binding of this.doc.bindingsOf(id)) {
        const arrow = this.doc.shape(binding.fromId) as TLArrowShape | undefined;
        if (arrow !== undefined && !doomed.has(arrow.id)) {
          // ArrowBindingUtil.onBeforeIsolateFromShape: the arrow keeps the
          // end it was drawn with.
          const course = arrowPath(this.doc, arrow);
          const point = binding.props.terminal === "start" ? course[0]! : course.at(-1)!;
          this.put(withProps(arrow, { [binding.props.terminal]: { x: point.x, y: point.y } }));
        }
        this.doc.remove(binding.id);
      }
    }
    for (const id of doomed) this.doc.remove(id);
    this.selected = this.selected.filter((id) => !doomed.has(id));
    return this;
  }

  createBindings(partials: Omit<TLArrowBinding, "meta">[]): this {
    const arrows = new Set<TLShapeId>();
    for (const partial of partials) {
      this.put({ meta: {}, ...partial } as TLArrowBinding);
      arrows.add(partial.fromId);
    }
    for (const id of arrows) this.settleArrow(id);
    return this;
  }

  // ArrowBindingUtil's reparentArrow: an arrow lives in the frame both its
  // ends share, just above the higher of the shapes it joins and below the
  // next shape that is not an arrow.
  private settleArrow(id: TLShapeId) {
    let arrow = this.doc.shape(id) as TLArrowShape | undefined;
    if (arrow === undefined) return;
    const bound = this.getBindingsFromShape(id, "arrow")
      .map((binding) => this.doc.shape(binding.toId))
      .filter((shape) => shape !== undefined);
    if (bound.length === 0) return;
    let parentId: TLParentId = this.pageId;
    if (bound.length === 2) {
      const targetAncestors = new Set(this.ancestors(bound[1]!));
      parentId =
        this.ancestors(bound[0]!).find((ancestor) => targetAncestors.has(ancestor)) ?? this.pageId;
    } else if (bound[0]!.parentId === arrow.parentId) {
      parentId = arrow.parentId;
    }
    if (parentId !== arrow.parentId) {
      const onPage = apply(pageTransform(this.doc, arrow), { x: 0, y: 0 });
      const local = apply(toParentSpace(this.doc, parentId), onPage);
      const siblings = this.doc.children(parentId);
      arrow = {
        ...arrow,
        index: getIndexAbove(siblings.at(-1)?.index ?? null),
        parentId,
        x: local.x,
        y: local.y,
      };
      this.put(arrow);
    }
    const nearest = bound
      .map((shape) => {
        let at: TLShape | undefined = shape;
        while (at !== undefined && at.parentId !== parentId) at = this.doc.shape(at.parentId);
        return at;
      })
      .filter((shape) => shape !== undefined);
    if (nearest.length === 0) return;
    const highest = [...nearest].sort((a, b) => (a.index < b.index ? 1 : -1))[0]!;
    const above = this.doc
      .children(parentId)
      .filter((sibling) => sibling.index > highest.index && sibling.id !== arrow.id);
    const nextSolid = above.find((sibling) => sibling.type !== "arrow");
    if (arrow.index > highest.index && (nextSolid === undefined || arrow.index < nextSolid.index)) {
      return;
    }
    const index =
      above.length === 0
        ? getIndexAbove(highest.index)
        : getIndexBetween(highest.index, above[0]!.index);
    this.put({ ...arrow, index });
  }

  private ancestors(shape: TLShape): TLParentId[] {
    const out: TLParentId[] = [];
    let at: TLShape | undefined = shape;
    while (at !== undefined) {
      out.push(at.parentId);
      at = this.doc.shape(at.parentId);
    }
    return out;
  }

  /**
   * Editor.resizeShape for the shapes the engine resizes this way: lines and
   * strokes, scaled about a page point along the page's axes.
   */
  resizeShape(
    value: IdOrShape,
    scale: Vec,
    options: { scaleAxisRotation?: number; scaleOrigin?: Vec } = {},
  ): this {
    const shape = this.lookup(value);
    if (shape === undefined || this.isShapeOrAncestorLocked(shape)) return this;
    const origin = options.scaleOrigin ?? this.getShapePageBounds(shape)!.center;
    const onPage = apply(pageTransform(this.doc, shape), { x: 0, y: 0 });
    const moved = {
      x: origin.x + (onPage.x - origin.x) * scale.x,
      y: origin.y + (onPage.y - origin.y) * scale.y,
    };
    const { x, y } = apply(toParentSpace(this.doc, shape.parentId), moved);
    // NOTE: the scale is along the page's axes; a shape a quarter turn round
    // has its own axes swapped. Off those axes the engine only scales evenly.
    const [sin, cos] = this.rotationOf(shape).map((part) => Math.abs(Math.round(part))) as [
      number,
      number,
    ];
    const even = scale.x === scale.y;
    scale = even ? scale : { x: cos * scale.x + sin * scale.y, y: sin * scale.x + cos * scale.y };
    if (shape.type === "line") {
      const { points } = (shape as TLLineShape).props;
      const scaled = Object.fromEntries(
        Object.entries(points).map(([key, point]) => [
          key,
          { ...point, x: point.x * scale.x, y: point.y * scale.y },
        ]),
      );
      this.put({ ...withProps(shape, { points: scaled }), x, y } as TLShape);
    } else if (shape.type === "draw" || shape.type === "highlight") {
      const { scaleX, scaleY } = (shape as TLDrawShape).props;
      this.put({
        ...withProps(shape, { scaleX: scaleX * scale.x, scaleY: scaleY * scale.y }),
        x,
        y,
      } as TLShape);
    } else {
      throw new Error(`This board cannot resize a ${shape.type} shape this way`);
    }
    return this;
  }

  // --- what tldraw's engine tests drive besides the engine ---------------------

  select(...ids: TLShapeId[]): this {
    this.selected = ids;
    return this;
  }

  /** Rotates each shape about its own centre. */
  rotateShapesBy(ids: TLShapeId[], delta: number): this {
    for (const id of ids) {
      const shape = this.lookup(id);
      if (shape === undefined) continue;
      const centre = this.getShapePageBounds(shape)!.center;
      const origin = apply(pageTransform(this.doc, shape), { x: 0, y: 0 });
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      const dx = origin.x - centre.x;
      const dy = origin.y - centre.y;
      const moved = { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
      const local = apply(toParentSpace(this.doc, shape.parentId), moved);
      this.put({ ...shape, rotation: shape.rotation + delta, x: local.x, y: local.y });
    }
    return this;
  }
}

function withProps(shape: TLShape, props: Record<string, unknown>): TLShape {
  return { ...shape, props: { ...shape.props, ...props } } as TLShape;
}
