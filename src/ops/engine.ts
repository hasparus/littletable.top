import {
  createShapeId,
  type TLArrowShape,
  type TLGeoShape,
  type TLNoteShape,
  type TLPage,
  type TLParentId,
  type TLRecord,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  type TLTextShape,
} from "@tldraw/tlschema";
import { getIndexAbove, getIndexBetween, type IndexKey } from "@tldraw/utils";

import { Doc } from "./doc";
import {
  apply,
  type Box,
  center,
  pageBounds,
  pageToLocal,
  terminalOnPage,
  toParentSpace,
  type Vec,
} from "./geometry";
import {
  clearSpot,
  DEFAULT_GAP,
  excludeFor,
  idealSpot,
  obstacles,
  type Relation,
} from "./placement";
import {
  arrowBindingRecord,
  arrowRecord,
  fromShapeId,
  geoRecord,
  InvalidRecord,
  noteRecord,
  textOf,
  textRecord,
  toRichText,
  toShapeId,
  validate,
} from "./records";
import { routeArrow } from "./routing";
import {
  type ApplyOpsResult,
  type Op,
  type OpResult,
  opsBatch,
  type Ref,
  type RefList,
  type TargetOrPoint,
} from "./schema";
import { type FontFamily, measureRichText } from "./text/measure";
import {
  ARROW_LABEL_SIZE,
  geoGrowY,
  geoLabelSize,
  isEmptyRichText,
  noteSizing,
  type SizeStyle,
  textShapeSize,
} from "./text/sizing";

// apply_ops on the server: a batch of ops compiled against the board's
// records, with no editor and no browser. Each op runs on its own; one that
// fails is rolled back and reported while the rest go on. The caller writes
// whatever the batch changed in one storage transaction.

export class OpError extends Error {}

export type Run = {
  /** Shapes made earlier in this run, oldest first: what {created} refers to. */
  created: string[];
};

export type BatchInput = {
  batchId: string;
  now: number;
  ops: unknown;
  page?: number | string | null;
  run: Run;
  runId?: string;
};

export type BatchOutcome =
  | {
      /** Ids this batch creates, which must still be free when it is written. */
      absent: string[];
      created: string[];
      deletes: string[];
      kind: "applied";
      puts: TLRecord[];
      result: ApplyOpsResult;
      /** Records the batch relied on or overwrites: unchanged since the snapshot, or it is stale. */
      unchanged: string[];
    }
  | { kind: "invalid"; message: string }
  | { kind: "no-page"; message: string };

const MAX_AUTO_WIDTH = 320;
const MIN_BOX = { h: 80, w: 120 };
const ELLIPSE_ROOM = 1.3;
const LABEL_GAP = 24;

type Context = {
  batchId: string;
  created: string[];
  doc: Doc;
  now: number;
  page: TLPage;
  runId?: string;
};

const round = (n: number) => Math.round(n * 100) / 100;
const describeBox = (box: Box) =>
  `at (${Math.round(box.x)}, ${Math.round(box.y)}), ${Math.round(box.w)}×${Math.round(box.h)}`;
const quote = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);

function pageFor(doc: Doc, page: BatchInput["page"]): TLPage | string {
  const pages = doc.pages();
  if (pages.length === 0) return "This board has no pages.";
  if (page === undefined || page === null) return pages[0]!;
  if (typeof page === "number") {
    return (
      pages[page] ??
      `There is no page ${page}; this board has ${pages.length} (0 to ${pages.length - 1}).`
    );
  }
  const id = page.startsWith("page:") ? page : `page:${page}`;
  return pages.find((candidate) => candidate.id === id) ?? `There is no page with the id ${page}.`;
}

export function runBatch(records: Iterable<TLRecord>, input: BatchInput): BatchOutcome {
  const parsed = opsBatch.safeParse(input.ops);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 10)
      .map(
        (issue) =>
          `ops${issue.path.map((part) => `[${JSON.stringify(part)}]`).join("")}: ${issue.message}`,
      )
      .join("; ");
    return {
      kind: "invalid",
      message: `The batch is invalid and nothing was applied. ${detail}`.slice(0, 1500),
    };
  }
  const doc = new Doc(records);
  const page = pageFor(doc, input.page);
  if (typeof page === "string") return { kind: "no-page", message: page };
  const ctx: Context = {
    batchId: input.batchId,
    created: [...input.run.created],
    doc,
    now: input.now,
    page,
    runId: input.runId,
  };
  const results: OpResult[] = [];
  for (const [index, op] of parsed.data.entries()) {
    const mark = doc.mark();
    const createdBefore = ctx.created.length;
    try {
      const outcome = HANDLERS[op.op](ctx, op as never);
      const touched = doc.touchedSince(mark);
      for (const record of touched.puts) validate(record);
      results.push({ index, ok: true, op: op.op, ...outcome });
    } catch (error) {
      doc.rollback(mark);
      ctx.created.length = createdBefore;
      if (!(error instanceof OpError) && !(error instanceof InvalidRecord)) throw error;
      const message =
        error instanceof InvalidRecord
          ? `This op would have written a record tldraw refuses (${error.message}); nothing of it was applied.`
          : error.message;
      results.push({ index, message, ok: false, op: op.op, shapeIds: [] });
    }
  }
  const { deletes, puts } = doc.changes();
  doc.depend(page.id);
  return {
    ...doc.preconditions(),
    created: ctx.created.slice(input.run.created.length),
    deletes,
    kind: "applied",
    puts,
    result: {
      applied: results.filter((result) => result.ok).length,
      batchId: input.batchId,
      errors: results
        .filter((result) => !result.ok)
        .map((result) => `Op ${result.index} (${result.op}): ${result.message}`),
      pageId: page.id,
      pageName: page.name,
      results,
    },
  };
}

type Outcome = Omit<OpResult, "index" | "ok" | "op">;
type Handler<K extends Op["op"]> = (ctx: Context, op: Extract<Op, { op: K }>) => Outcome;

// --- references ---------------------------------------------------------

const normalise = (text: string) => text.trim().replaceAll(/\s+/gu, " ").toLowerCase();

function onPage(ctx: Context): TLShape[] {
  return ctx.doc.shapesOnPage(ctx.page.id);
}

function describeShape(ctx: Context, shape: TLShape): string {
  return `${fromShapeId(shape.id)} (${shape.type} ${describeBox(pageBounds(ctx.doc, shape))})`;
}

function byText(ctx: Context, text: string): TLShape[] {
  const wanted = normalise(text);
  const shapes = onPage(ctx).filter((shape) => shape.type !== "arrow" || textOf(shape) !== "");
  const exact = shapes.filter((shape) => normalise(textOf(shape)) === wanted);
  if (exact.length > 0) return exact;
  return shapes.filter((shape) => wanted.length >= 3 && normalise(textOf(shape)).includes(wanted));
}

function resolve(ctx: Context, ref: Ref): TLShape {
  const shape = find(ctx, ref);
  ctx.doc.depend(shape.id);
  return shape;
}

function find(ctx: Context, ref: Ref): TLShape {
  if (typeof ref === "string") {
    const shape = ctx.doc.shape(toShapeId(ref));
    if (shape === undefined || ctx.doc.pageOf(shape) !== ctx.page.id) {
      throw new OpError(`No shape on this page has the id ${ref}.`);
    }
    return shape;
  }
  if ("text" in ref) {
    const found = byText(ctx, ref.text);
    if (found.length === 1) return found[0]!;
    if (found.length === 0) {
      throw new OpError(
        `No shape on this page has the text ${quote(ref.text)}. Use an id from get_cluster_info.`,
      );
    }
    const listed = found.slice(0, 5).map((shape) => describeShape(ctx, shape));
    throw new OpError(
      `${found.length} shapes have the text ${quote(ref.text)}: ${listed.join(", ")}${found.length > 5 ? ", ..." : ""}. Use an id.`,
    );
  }
  if ("created" in ref) {
    const id = ref.created === "last" ? ctx.created.at(-1) : ctx.created[ref.created];
    const shape = id === undefined ? undefined : ctx.doc.shape(id);
    if (shape === undefined) {
      throw new OpError(
        ctx.created.length === 0
          ? "This run has made no shapes yet. Pass the same runId across calls to refer to earlier ones."
          : `This run made ${ctx.created.length} shapes (0 to ${ctx.created.length - 1}); ${String(ref.created)} is not one that still exists.`,
      );
    }
    return shape;
  }
  if ("selected" in ref) {
    throw new OpError(
      "Selections live in a person's open tab; this server-side engine does not read them yet. Use an id or {text}.",
    );
  }
  throw new OpError("Shapes cannot be found by description yet. Use an id or {text}.");
}

function resolveList(ctx: Context, refs: RefList): TLShape[] {
  if (Array.isArray(refs)) {
    const out = new Map<string, TLShape>();
    for (const ref of refs) {
      const shape = resolve(ctx, ref);
      out.set(shape.id, shape);
    }
    return [...out.values()];
  }
  if ("text" in refs) {
    const found = byText(ctx, refs.text);
    if (found.length === 0)
      throw new OpError(`No shape on this page has the text ${quote(refs.text)}.`);
    for (const shape of found) ctx.doc.depend(shape.id);
    return found;
  }
  if ("created" in refs) {
    const shapes = ctx.created
      .map((id) => ctx.doc.shape(id))
      .filter((shape) => shape !== undefined);
    if (shapes.length === 0) throw new OpError("This run has made no shapes that still exist.");
    for (const shape of shapes) ctx.doc.depend(shape.id);
    return shapes;
  }
  return [resolve(ctx, refs)];
}

// --- writing --------------------------------------------------------------

function topIndex(ctx: Context, parentId: TLParentId): IndexKey {
  const children = ctx.doc.children(parentId);
  return getIndexAbove(children.at(-1)?.index ?? null);
}

function newId(ctx: Context, key: string | undefined): TLShapeId {
  if (key === undefined) return createShapeId();
  const id = toShapeId(key);
  if (ctx.doc.get(id) !== undefined)
    throw new OpError(`A shape with the id ${key} already exists; use a new id.`);
  return id;
}

const agentMeta = (ctx: Context) => ({
  agent: {
    at: new Date(ctx.now).toISOString(),
    batchId: ctx.batchId,
    ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
  },
});

function edited(ctx: Context, shape: TLShape, changes: Partial<TLShape>): TLShape {
  return {
    ...shape,
    ...changes,
    meta: {
      ...shape.meta,
      agentEdit: { at: new Date(ctx.now).toISOString(), batchId: ctx.batchId },
    },
  } as TLShape;
}

// --- add -------------------------------------------------------------------

type Spec = {
  build: (base: {
    id: TLShapeId;
    index: IndexKey;
    parentId: TLParentId;
    x: number;
    y: number;
  }) => TLShape;
  h: number;
  noun: string;
  w: number;
};

function fitBox(richText: TLRichText, font: FontFamily, size: SizeStyle, ellipse: boolean) {
  if (isEmptyRichText(richText)) return { h: 100, w: 100 };
  const room = ellipse ? ELLIPSE_ROOM : 1;
  const unwrapped = geoLabelSize(richText, { font, size, w: 100_000 });
  const w = Math.ceil(Math.min(MAX_AUTO_WIDTH, Math.max(MIN_BOX.w, unwrapped.w * room)));
  const label = geoLabelSize(richText, { font, size, w: w / room });
  return { h: Math.ceil(Math.max(MIN_BOX.h, label.h * room)), w };
}

function addSpec(op: Extract<Op, { op: "add" }>): Spec {
  const kind = op.kind ?? (op.geo === undefined ? "box" : "shape");
  const richText = toRichText(op.text ?? "");
  const font: FontFamily = "draw";
  const size = (op.size ?? "m") as SizeStyle;
  const color = op.color ?? "black";
  if (kind === "label") {
    const fixed = op.w !== undefined;
    const measured = textShapeSize(richText, { autoSize: !fixed, font, size, w: op.w ?? 0 });
    return {
      build: (base) =>
        textRecord(
          { ...base, meta: {} },
          { autoSize: !fixed, color, font, richText, size, w: measured.w },
        ),
      h: measured.h,
      noun: "label",
      w: measured.w,
    };
  }
  if (kind === "note") {
    const sizing = noteSizing(richText, { font, size });
    return {
      build: (base) =>
        noteRecord(
          { ...base, meta: {} },
          {
            color: op.color ?? "black",
            font,
            fontSizeAdjustment: sizing.fontSizeAdjustment,
            growY: sizing.growY,
            richText,
            size,
          },
        ),
      h: 200 + sizing.growY,
      noun: "note",
      w: 200,
    };
  }
  const geo =
    kind === "ellipse" ? "ellipse" : kind === "shape" ? (op.geo ?? "rectangle") : "rectangle";
  const fitted = fitBox(richText, font, size, geo === "ellipse");
  const w = op.w ?? fitted.w;
  const h = op.h ?? fitted.h;
  const { growY } = geoGrowY(richText, { font, h, size, w });
  return {
    build: (base) =>
      geoRecord(
        { ...base, meta: {} },
        {
          color,
          dash: op.dash ?? "draw",
          fill: op.fill ?? "none",
          font,
          geo,
          growY,
          h,
          richText,
          size,
          w,
        },
      ),
    h: h + growY,
    noun: geo === "rectangle" ? "box" : geo,
    w,
  };
}

type Placed = { adjusted?: string; parentId: TLParentId; x: number; y: number };

function placeNew(
  ctx: Context,
  size: { h: number; w: number },
  where: {
    align?: "center" | "end" | "start";
    at?: Vec;
    gap?: number;
    relation?: Relation;
    target?: Ref;
  },
): Placed {
  if (where.at !== undefined) return { parentId: ctx.page.id, ...where.at };
  let target: TLShape | undefined;
  let relation = where.relation ?? "right_of";
  if (where.target !== undefined) {
    target = resolve(ctx, where.target);
  } else if (where.relation === undefined) {
    const last = ctx.created.at(-1);
    target = last === undefined ? undefined : ctx.doc.shape(last);
    if (target !== undefined) ctx.doc.depend(target.id);
    relation = "right_of";
  } else {
    throw new OpError(`relation ${where.relation} needs a target.`);
  }
  if (target === undefined) {
    const blockers = obstacles(ctx.doc, ctx.page.id, new Set());
    const boxes = onPage(ctx).map((shape) => pageBounds(ctx.doc, shape));
    const right = boxes.length === 0 ? null : Math.max(...boxes.map((box) => box.x + box.w));
    const top = boxes.length === 0 ? 0 : Math.min(...boxes.map((box) => box.y));
    const ideal = { x: right === null ? 0 : right + DEFAULT_GAP * 2, y: top };
    return { parentId: ctx.page.id, ...clearSpot(ideal, size, blockers, "right_of", null) };
  }
  const box = pageBounds(ctx.doc, target);
  const ideal = idealSpot(box, size, { align: where.align, gap: where.gap, relation });
  if (relation === "inside" || relation === "centered_on") {
    const parentId = relation === "inside" && target.type === "frame" ? target.id : ctx.page.id;
    const local = apply(toParentSpace(ctx.doc, parentId), ideal);
    return { parentId, ...local };
  }
  const blockers = obstacles(ctx.doc, ctx.page.id, excludeFor(ctx.doc, [target]));
  const spot = clearSpot(ideal, size, blockers, relation, box);
  const moved = Math.hypot(spot.x - ideal.x, spot.y - ideal.y);
  return {
    adjusted:
      moved > 0.5
        ? `moved ${Math.round(moved)} px from (${Math.round(ideal.x)}, ${Math.round(ideal.y)}) to keep clear of other shapes`
        : undefined,
    parentId: ctx.page.id,
    ...spot,
  };
}

const add: Handler<"add"> = (ctx, op) => {
  const spec = addSpec(op);
  const id = newId(ctx, op.id);
  const placed = placeNew(ctx, spec, op);
  const shape = spec.build({
    id,
    index: topIndex(ctx, placed.parentId),
    parentId: placed.parentId,
    x: round(placed.x),
    y: round(placed.y),
  });
  ctx.doc.put({ ...shape, meta: agentMeta(ctx) } as TLShape);
  ctx.created.push(id);
  const box = pageBounds(ctx.doc, ctx.doc.shape(id)!);
  return {
    adjusted: placed.adjusted,
    message: `Added a ${spec.noun}${op.text ? ` ${quote(op.text)}` : ""} ${describeBox(box)}.`,
    shapeIds: [fromShapeId(id)],
  };
};

// --- connect ---------------------------------------------------------------

type End = { point: Vec; shape?: TLShape };

function endOf(ctx: Context, end: TargetOrPoint): End {
  if (typeof end === "object" && "point" in end) return { point: end.point };
  const shape = resolve(ctx, end);
  if (shape.type === "arrow")
    throw new OpError(`${fromShapeId(shape.id)} is an arrow; arrows join shapes, not arrows.`);
  return { point: center(pageBounds(ctx.doc, shape)), shape };
}

// As tldraw keeps a bound arrow (its ArrowBindingUtil): just above the
// higher of the shapes it joins, below the next shape that is not an arrow.
// An arrow written there is one no browser moves on arrival.
function arrowIndex(ctx: Context, parentId: TLParentId, joined: TLShape[]): IndexKey {
  const siblings = ctx.doc.children(parentId);
  const nearest = joined
    .map((shape) => {
      let current: TLShape | undefined = shape;
      while (current !== undefined && current.parentId !== parentId)
        current = ctx.doc.shape(current.parentId);
      return current;
    })
    .filter((shape) => shape !== undefined);
  if (nearest.length === 0) return topIndex(ctx, parentId);
  const highest = [...nearest].sort((a, b) => (a.index < b.index ? 1 : -1))[0]!;
  const above = siblings.filter((sibling) => sibling.index > highest.index);
  return above.length === 0
    ? getIndexAbove(highest.index)
    : getIndexBetween(highest.index, above[0]!.index);
}

function commonParent(ctx: Context, shapes: TLShape[]): TLParentId {
  if (shapes.length === 2 && shapes[0]!.parentId === shapes[1]!.parentId) {
    const parent = ctx.doc.shape(shapes[0]!.parentId);
    if (parent?.type === "frame") return parent.id;
  }
  return ctx.page.id;
}

// tldraw's arrow label box: its font at the arrow's size, with padding.
function arrowLabelSize(richText: TLRichText) {
  const measured = measureRichText(richText, {
    family: "draw",
    fontSize: 16 * ARROW_LABEL_SIZE.m,
    lineHeight: 1.35,
    maxWidth: null,
  });
  return { h: measured.h + 8.5, w: measured.w + 8.5 };
}

function connectArrow(
  ctx: Context,
  {
    color,
    dash,
    from,
    id: key,
    text,
    to,
  }: { color?: string; dash?: string; from: End; id?: string; text?: string; to: End },
): { adjusted?: string; id: TLShapeId; replaced: boolean } {
  if (from.shape !== undefined && from.shape.id === to.shape?.id) {
    throw new OpError(
      "An arrow needs two different ends; this one starts and ends on the same shape.",
    );
  }
  let id: TLShapeId;
  let replaced = false;
  const existing = key === undefined ? undefined : ctx.doc.get(toShapeId(key));
  if (key !== undefined && existing !== undefined) {
    if (existing.typeName !== "shape" || (existing as TLShape).type !== "arrow") {
      throw new OpError(`${key} is not an arrow; only an arrow's id can be reused to replace it.`);
    }
    id = existing.id as TLShapeId;
    replaced = true;
    for (const binding of ctx.doc.bindingsOf(id))
      if (binding.fromId === id) ctx.doc.remove(binding.id);
  } else {
    id = newId(ctx, key);
  }
  const joined = [from.shape, to.shape].filter((shape) => shape !== undefined);
  const parentId = commonParent(ctx, joined);
  const richText = toRichText(text ?? "");
  const { bend, crossed } = routeArrow({
    blockers: obstacles(
      ctx.doc,
      ctx.page.id,
      excludeFor(ctx.doc, [...joined, ...(existing === undefined ? [] : [existing as TLShape])]),
    ),
    from: from.point,
    joined: joined.map((shape) => pageBounds(ctx.doc, shape)),
    label: text ? arrowLabelSize(richText) : null,
    to: to.point,
  });
  const toLocal = toParentSpace(ctx.doc, parentId);
  const origin = apply(toLocal, from.point);
  const tip = apply(toLocal, to.point);
  const arrow = arrowRecord(
    {
      id,
      index: replaced ? (existing as TLShape).index : arrowIndex(ctx, parentId, joined),
      meta: agentMeta(ctx),
      parentId,
      x: round(origin.x),
      y: round(origin.y),
    },
    {
      color: color ?? "black",
      dash: dash ?? "draw",
      end: { x: round(tip.x - origin.x), y: round(tip.y - origin.y) },
      font: "draw",
      richText,
      size: "m",
    },
  );
  const routed = { ...arrow, props: { ...arrow.props, bend } } as TLShape;
  ctx.doc.put(routed);
  if (from.shape !== undefined) ctx.doc.put(arrowBindingRecord(id, from.shape.id, "start"));
  if (to.shape !== undefined) ctx.doc.put(arrowBindingRecord(id, to.shape.id, "end"));
  if (!replaced) ctx.created.push(id);
  const crossing =
    crossed > 0
      ? `crosses ${crossed} other shape${crossed === 1 ? "" : "s"}; no bend clears ${crossed === 1 ? "it" : "them"}`
      : undefined;
  const adjusted =
    bend === 0
      ? crossing
      : `bent ${Math.abs(bend)} px to the ${bend > 0 ? "left" : "right"} of the straight line to pass clear of other shapes`;
  return { adjusted, id, replaced };
}

const endName = (ctx: Context, end: End) =>
  end.shape === undefined
    ? `(${Math.round(end.point.x)}, ${Math.round(end.point.y)})`
    : fromShapeId(end.shape.id);

const connect: Handler<"connect"> = (ctx, op) => {
  const from = endOf(ctx, op.from);
  const to = endOf(ctx, op.to);
  const { adjusted, id, replaced } = connectArrow(ctx, { ...op, from, to });
  return {
    adjusted,
    message: `${replaced ? "Replaced the arrow" : "Added an arrow"} from ${endName(ctx, from)} to ${endName(ctx, to)}${op.text ? ` labelled ${quote(op.text)}` : ""}.`,
    shapeIds: [fromShapeId(id)],
  };
};

// --- rename ------------------------------------------------------------------

function retext(
  ctx: Context,
  shape: TLShape,
  text: string,
  fit?: "shrink_text" | "widen",
): { adjusted?: string; shape: TLShape } {
  const richText = toRichText(text);
  switch (shape.type) {
    case "arrow":
      return {
        shape: edited(ctx, shape, {
          props: { ...(shape as TLArrowShape).props, richText },
        } as Partial<TLShape>),
      };
    case "frame":
      return {
        shape: edited(ctx, shape, { props: { ...shape.props, name: text } } as Partial<TLShape>),
      };
    case "geo": {
      const geo = shape as TLGeoShape;
      const style = { font: geo.props.font as FontFamily, size: geo.props.size as SizeStyle };
      let { size } = geo.props;
      let { w } = geo.props;
      let adjusted: string | undefined;
      if (fit === "widen") {
        const unwrapped = geoLabelSize(richText, { ...style, w: 100_000 });
        const wider = Math.ceil(Math.min(Math.max(w, unwrapped.w), MAX_AUTO_WIDTH * 2));
        if (wider > w) adjusted = `widened from ${Math.round(w)} to ${wider} px`;
        w = Math.max(w, wider);
      } else if (fit === "shrink_text") {
        const order: SizeStyle[] = ["xl", "l", "m", "s"];
        for (const candidate of order.slice(order.indexOf(size as SizeStyle))) {
          size = candidate;
          if (geoLabelSize(richText, { ...style, size: candidate, w }).h <= geo.props.h) break;
        }
        if (size !== geo.props.size) adjusted = `text size ${geo.props.size} to ${size}`;
      }
      // As tldraw's geo util does on a text edit: grow to the label, never shrink.
      const label = geoLabelSize(richText, { ...style, size: size as SizeStyle, w });
      const wasEmpty = isEmptyRichText(geo.props.richText);
      const h = wasEmpty ? Math.max(geo.props.h, label.h) : geo.props.h;
      w = Math.max(w, label.w);
      const growY = label.h > h ? label.h - h : 0;
      return {
        adjusted,
        shape: edited(ctx, shape, {
          props: { ...geo.props, growY, h, richText, size, w },
        } as Partial<TLShape>),
      };
    }
    case "note": {
      const note = shape as TLNoteShape;
      const sizing = noteSizing(richText, {
        font: note.props.font as FontFamily,
        size: note.props.size as SizeStyle,
      });
      return {
        shape: edited(ctx, shape, {
          props: {
            ...note.props,
            fontSizeAdjustment: sizing.fontSizeAdjustment,
            growY: sizing.growY,
            richText,
          },
        } as Partial<TLShape>),
      };
    }
    case "text": {
      const textShape = shape as TLTextShape;
      const style = {
        font: textShape.props.font as FontFamily,
        size: textShape.props.size as SizeStyle,
      };
      const after = textShapeSize(richText, {
        ...style,
        autoSize: textShape.props.autoSize,
        w: textShape.props.w,
      });
      return {
        shape: edited(ctx, shape, {
          props: { ...textShape.props, richText, w: after.w },
        } as Partial<TLShape>),
      };
    }
    default:
      throw new OpError(`${fromShapeId(shape.id)} is a ${shape.type}, which holds no text.`);
  }
}

const rename: Handler<"rename"> = (ctx, op) => {
  const shape = resolve(ctx, op.target);
  const { adjusted, shape: next } = retext(ctx, shape, op.text, op.fit);
  ctx.doc.put(next);
  return {
    adjusted,
    message: `Renamed ${fromShapeId(shape.id)} to ${quote(op.text)}; it is now ${describeBox(pageBounds(ctx.doc, next))}.`,
    shapeIds: [fromShapeId(shape.id)],
  };
};

// --- label -------------------------------------------------------------------

const SIDES: Record<"above" | "below" | "left" | "right", Relation> = {
  above: "above",
  below: "below",
  left: "left_of",
  right: "right_of",
};

const label: Handler<"label"> = (ctx, op) => {
  const size = (op.size ?? "m") as SizeStyle;
  const richText = toRichText(op.text);
  const measured = textShapeSize(richText, { autoSize: true, font: "draw", size, w: 0 });
  const dims = { h: measured.h, w: measured.w };
  const id = newId(ctx, op.id);
  let placed: Placed;
  let target: TLShape | undefined;
  if (typeof op.target === "object" && "point" in op.target) {
    placed = {
      parentId: ctx.page.id,
      x: op.target.point.x - dims.w / 2,
      y: op.target.point.y - dims.h / 2,
    };
  } else {
    target = resolve(ctx, op.target);
    const gap = op.gap ?? LABEL_GAP;
    const box = pageBounds(ctx.doc, target);
    const blockers = obstacles(ctx.doc, ctx.page.id, excludeFor(ctx.doc, [target]));
    const sides =
      op.side === undefined || op.side === "auto"
        ? (["right", "below", "left", "above"] as const)
        : [op.side];
    const options = sides.map((side) => {
      const relation = SIDES[side];
      const ideal = idealSpot(box, dims, { gap, relation });
      const spot = clearSpot(ideal, dims, blockers, relation, box);
      return { ideal, moved: Math.hypot(spot.x - ideal.x, spot.y - ideal.y), side, spot };
    });
    const best =
      options.find((option) => option.moved < 0.5) ??
      [...options].sort((a, b) => a.moved - b.moved)[0]!;
    placed = {
      adjusted:
        best.moved > 0.5
          ? `placed ${Math.round(best.moved)} px off the ${best.side} side to keep clear of other shapes`
          : undefined,
      parentId: ctx.page.id,
      ...best.spot,
    };
  }
  const shape = textRecord(
    {
      id,
      index: topIndex(ctx, placed.parentId),
      meta: agentMeta(ctx),
      parentId: placed.parentId,
      x: round(placed.x),
      y: round(placed.y),
    },
    { autoSize: true, color: op.color ?? "black", font: "draw", richText, size, w: dims.w },
  );
  ctx.doc.put(shape);
  ctx.created.push(id);
  const ids = [fromShapeId(id)];
  if (op.arrow === true && target !== undefined) {
    const arrow = connectArrow(ctx, {
      from: { point: center(pageBounds(ctx.doc, shape)), shape },
      to: { point: center(pageBounds(ctx.doc, target)), shape: target },
    });
    ids.push(fromShapeId(arrow.id));
  }
  return {
    adjusted: placed.adjusted,
    message: `Added the label ${quote(op.text)} ${describeBox(pageBounds(ctx.doc, shape))}${target === undefined ? "" : ` by ${fromShapeId(target.id)}`}${op.arrow && target ? ", with an arrow to it" : ""}.`,
    shapeIds: ids,
  };
};

// --- remove ------------------------------------------------------------------

const remove: Handler<"remove"> = (ctx, op) => {
  const shapes = resolveList(ctx, op.targets);
  const doomed = excludeFor(ctx.doc, shapes);
  let freed = 0;
  for (const id of doomed) {
    for (const binding of ctx.doc.bindingsOf(id)) {
      const arrow = ctx.doc.shape(binding.fromId) as TLArrowShape | undefined;
      if (arrow !== undefined && !doomed.has(arrow.id)) {
        // An arrow that outlives the shape it pointed at stays where it was.
        const { point } = terminalOnPage(ctx.doc, arrow, binding.props.terminal, binding);
        const local = apply(pageToLocal(ctx.doc, arrow), point);
        ctx.doc.put(
          edited(ctx, arrow, {
            props: {
              ...arrow.props,
              [binding.props.terminal]: { x: round(local.x), y: round(local.y) },
            },
          } as Partial<TLShape>),
        );
        freed++;
      }
      ctx.doc.remove(binding.id);
    }
  }
  for (const id of doomed) ctx.doc.remove(id);
  return {
    message: `Removed ${doomed.size} shape${doomed.size === 1 ? "" : "s"}${freed > 0 ? `; ${freed} arrow end${freed === 1 ? " stays" : "s stay"} where the removed shape was` : ""}.`,
    shapeIds: [...doomed].map(fromShapeId),
  };
};

// --- not yet -----------------------------------------------------------------

const later =
  <K extends Op["op"]>(name: K): Handler<K> =>
  () => {
    throw new OpError(`${name} is not supported by this board yet; nothing was changed.`);
  };

const HANDLERS: { [K in Op["op"]]: Handler<K> } = {
  add,
  connect,
  duplicate: later("duplicate"),
  label,
  path: later("path"),
  place: later("place"),
  remove,
  rename,
  resize: later("resize"),
  restyle: later("restyle"),
  untangle: later("untangle"),
};
