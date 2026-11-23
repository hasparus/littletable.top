// Adapted from tldraw: apps/dotcom/sync-worker/src/routes/tla/boardTools.ts
// at commit ebe1433 (an excerpt: the page, cluster and apply_ops tools).
// Copyright (c) tldraw Inc. Used with permission; what was changed is listed in
// docs/upstream-provenance.md.

import type { BoxModel, TLArrowBinding, TLShape, VecModel } from "@tldraw/tlschema";

import { b64Vecs } from "@tldraw/tlschema";

import type { MeasuredArrow, MeasuredDimensions } from "./shared/types";

import { CANVAS_OPS_BATCH_JSON_SCHEMA } from "./shared/canvasOpsJsonSchema";
import {
  type McpPageLookup,
  type McpPageRead,
  type PageSelector,
  toClusterBox,
  toThousandths,
} from "./shared/mcpPageRead";
import {
  type ClusterBounds,
  getShapeText,
  type ShapeCluster,
  type TLShapeWithPlainText,
} from "./shared/shapeClusters";

// CHANGED from upstream: only the board-info, page, cluster and apply_ops tools are kept (no
// tldraw.com boards search, workspaces, comments, feedback, presence or screenshots); a board is
// named by this deployment's ids; and nothing needs a browser tab, so the descriptions no longer
// ask for one.

export const BOARD_INFO_TOOL_NAME = "get_board_info";
export const PAGE_INFO_TOOL_NAME = "get_page_info";
export const CLUSTER_INFO_TOOL_NAME = "get_cluster_info";
export const CLUSTER_SCREENSHOT_TOOL_NAME = "get_cluster_screenshot";

export const APPLY_OPS_TOOL_NAME = "apply_ops";

export function parseBoardInfoInput(input: unknown): { boardId: string } {
  const value = requireArgumentsObject(input);
  return { boardId: parseBoardId(value.boardId) };
}

export function parsePageInfoInput(input: unknown): {
  boardId: string;
  page: PageSelector;
  cursor: number | null;
} {
  const value = requireArgumentsObject(input);
  const page = parsePageSelector(value.page);
  return {
    boardId: parseBoardId(value.boardId),
    page,
    cursor: parsePageInfoCursor(value.cursor, page),
  };
}

// Refused rather than read as the first page, for the reason search_boards gives. The cursor is an
// offset into one page's clusters, and means nothing on another.
function parsePageInfoCursor(value: unknown, page: PageSelector): number | null {
  if (value === undefined || value === null) return null;
  const invalid = new Error(
    "cursor is not valid. Omit it to start from the first cluster, or pass the nextCursor from a previous get_page_info result.",
  );
  if (typeof value !== "string") throw invalid;
  let parts: string[];
  try {
    parts = atob(value).split(":");
  } catch {
    throw invalid;
  }
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) throw invalid;
  let selector: string;
  try {
    selector = decodeURIComponent(parts[1]);
  } catch {
    throw invalid;
  }
  if (selector !== JSON.stringify(page)) {
    throw new Error(
      "cursor is from a different page. Repeat the page it came from, or omit the cursor to start from the first cluster.",
    );
  }
  return Number(parts[0]);
}

// Opaque, so the encoding can change without clients having to. The selector is percent-escaped
// because a page id can hold a `:`, and `btoa` throws outside Latin-1.
export function encodePageInfoCursor(offset: number, page: PageSelector): string {
  return btoa(`${offset}:${encodeURIComponent(JSON.stringify(page))}`);
}

// Bounds the request itself. Paging bounds the answer.
export const CLUSTER_INFO_MAX_IDS = 100;

/** Where a paged get_cluster_info answer picks up: a shape within one of the clusters asked for. */
export interface ClusterInfoCursor {
  cluster: number;
  shape: number;
}

export function parseClusterInfoInput(input: unknown): {
  boardId: string;
  page: PageSelector;
  clusterIds: string[];
  cursor: ClusterInfoCursor | null;
} {
  const value = requireArgumentsObject(input);
  // `clusterId` is the argument this tool took before it took several. A client holding the old tool
  // list still sends it.
  const clusterIds = [...new Set(parseClusterIds(value.clusterIds ?? value.clusterId))];
  if (clusterIds.length > CLUSTER_INFO_MAX_IDS) {
    throw new Error(
      `clusterIds takes at most ${CLUSTER_INFO_MAX_IDS} ids in one call. Split them across several calls.`,
    );
  }
  return {
    boardId: parseBoardId(value.boardId),
    page: parsePageSelector(value.page),
    clusterIds,
    cursor: parseClusterInfoCursor(value.cursor, clusterIds),
  };
}

// Refused rather than read as the first page, for the reason search_boards gives: a model whose
// cursor silently restarts sees its own answers repeat, with no sign the cursor was the problem.
function parseClusterInfoCursor(value: unknown, clusterIds: string[]): ClusterInfoCursor | null {
  if (value === undefined || value === null) return null;
  const invalid = new Error(
    "cursor is not valid. Omit it to start from the first shape, or pass the nextCursor from a previous get_cluster_info result.",
  );
  if (typeof value !== "string") throw invalid;
  let parts: string[];
  try {
    parts = atob(value).split(":");
  } catch {
    throw invalid;
  }
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) throw invalid;
  // A cursor is a position in one list of clusters. Passed on with a different list it would point
  // into clusters the caller never saw the start of.
  let ids: string;
  try {
    ids = decodeURIComponent(parts[2]);
  } catch {
    throw invalid;
  }
  if (ids !== clusterIds.join(",")) {
    throw new Error(
      "cursor is from a different set of clusterIds. Repeat the clusterIds it came from, or omit the cursor to start from the first shape.",
    );
  }
  return { cluster: Number(parts[0]), shape: Number(parts[1]) };
}

// Opaque, so the encoding can change without clients having to. The ids are percent-escaped because
// `btoa` throws outside Latin-1.
function encodeClusterInfoCursor(cursor: ClusterInfoCursor, clusterIds: string[]): string {
  return btoa(`${cursor.cluster}:${cursor.shape}:${encodeURIComponent(clusterIds.join(","))}`);
}

export const BOARD_NAME_MAX_LENGTH = 200;

const APPLY_OPS_MAX_OPS = CANVAS_OPS_BATCH_JSON_SCHEMA.properties.ops.maxItems;
// A batch goes to the tab as a single socket message. This is several times what 1,000 ordinary ops
// serialize to, so it only stops a batch that would stall the tab just parsing it.
const APPLY_OPS_MAX_LENGTH = 1024 * 1024;
const APPLY_OPS_MAX_RUN_ID_LENGTH = 200;

/** Only the outer shape: the tab owns the op vocabulary and validates each op against it. */
export function parseApplyOpsInput(input: unknown): {
  boardId: string;
  ops: unknown[];
  page: PageSelector | null;
  runId: string | null;
} {
  const value = requireArgumentsObject(input);
  const { ops, runId } = value;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error("ops must be a non-empty array of canvas ops");
  }
  if (ops.length > APPLY_OPS_MAX_OPS) {
    throw new Error(`ops can hold at most ${APPLY_OPS_MAX_OPS} ops; split the work across calls`);
  }
  if (JSON.stringify(ops).length > APPLY_OPS_MAX_LENGTH) {
    throw new Error("ops is too large; split the work across calls");
  }
  if (runId !== undefined) {
    if (typeof runId !== "string" || !runId || runId.length > APPLY_OPS_MAX_RUN_ID_LENGTH) {
      throw new Error(
        `runId must be a string of at most ${APPLY_OPS_MAX_RUN_ID_LENGTH} characters`,
      );
    }
  }
  return {
    boardId: parseBoardId(value.boardId),
    ops,
    // A model that fills in every field sends null, which means the same as leaving it out.
    page: value.page === undefined || value.page === null ? null : parsePageSelector(value.page),
    runId: runId ?? null,
  };
}

export function parseClusterIds(value: unknown): string[] {
  const ids = typeof value === "string" ? [value] : value;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("clusterIds is required: a cluster id, or an array of them");
  }
  if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error("clusterIds must each be a cluster id from get_page_info");
  }
  return ids;
}

function requireArgumentsObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    throw new Error("Tool arguments must be an object");
  }
  return input as Record<string, unknown>;
}

function parseBoardId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("boardId is required");
  }
  if (value.includes("/")) {
    throw new Error("boardId must be a board id, not a URL");
  }
  return value;
}

// Omitting the theme means light, but an unrecognized one is rejected rather than quietly treated
// as light: a caller asking for `blue` gets a wrong-but-plausible image back and no signal that the
// argument was ignored.
function parseTheme(value: unknown): "light" | "dark" {
  if (value === undefined || value === null) return "light";
  if (value !== "light" && value !== "dark") {
    throw new Error(`theme must be 'light' or 'dark'`);
  }
  return value;
}

function parsePageSelector(value: unknown): PageSelector {
  if (value === undefined || value === null) return { kind: "ordinal", ordinal: 0 };
  if (typeof value === "string") {
    if (!value.startsWith("page:")) {
      throw new Error(
        'page must be a 0-based page ordinal (a number) or a page id (the "page:…" string from get_board_info)',
      );
    }
    return { kind: "id", id: value };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("page must be a non-negative integer (0-based page ordinal) or a page id");
  }
  return { kind: "ordinal", ordinal: value };
}

/** How the page was named, for error messages that echo back what the caller actually passed. */
export function describePageSelector(selector: PageSelector) {
  return selector.kind === "id" ? `"${selector.id}"` : String(selector.ordinal);
}

// --- Tool results -------------------------------------------------------------------------------

export interface ToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export function toolError(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function toolPageResult(name: string, base64: string): ToolResult {
  return {
    content: [
      { type: "text", text: name },
      { type: "image", data: base64, mimeType: "image/png" },
    ],
  };
}

export function toolJsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

// --- The tools ----------------------------------------------------------------------------------

export type PageReadResult =
  | { ok: true; read: McpPageRead }
  | { ok: false; reason: "board_empty" | "page_not_found"; result: ToolResult };

/**
 * The error for a page a tab couldn't find, worded here with every other message a model reads.
 * `reason` is the telemetry code.
 */
export function pageLookupFailure(
  lookup: Extract<McpPageLookup, { ok: false }>,
  page: PageSelector,
): Extract<PageReadResult, { ok: false }> {
  if (lookup.reason === "no_pages") {
    return { ok: false, reason: "board_empty", result: toolError("This board has no pages.") };
  }
  return {
    ok: false,
    reason: "page_not_found",
    result: toolError(getPageNotFoundMessage(page, lookup.pageCount)),
  };
}

export function getPageNotFoundMessage(page: PageSelector, pageCount: number) {
  return page.kind === "id"
    ? `No page with id "${page.id}" on this board. Call get_board_info to list its pages; a page id is stable across reordering, an index is not.`
    : `Page ${page.ordinal} is out of range: this board has ${pageCount} page(s) (0–${pageCount - 1}). Call get_board_info to list them.`;
}

export const PAGE_INFO_MAX_CHARS = 40_000;

function roundClusterBox(box: BoxModel | null): BoxModel | null {
  if (!box) return null;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.w),
    h: Math.round(box.h),
  };
}

export function getPageInfo(
  { pageName, clusters }: McpPageRead,
  { selector, offset }: { selector: PageSelector; offset: number } = {
    selector: { kind: "ordinal", ordinal: 0 },
    offset: 0,
  },
): ToolResult {
  // Bounds let a model see what is near what without opening every cluster. They are null rather
  // than invented for a cluster the tab could not measure.
  const pageBounds = toClusterBox(
    clusters.flatMap(({ bounds }) => (bounds ? [toClusterBounds(bounds)] : [])),
  );

  // Scoped to the requested page: get_cluster_info and get_cluster_screenshot both resolve cluster
  // ids against a single page, so listing every shape on the board here would hand out ids that
  // neither of them can look up.
  //
  // Largest first, so a model that stops after the first answer has seen a big board's main areas.
  const ordered = [...clusters].sort((a, b) => b.numberOfShapes - a.numberOfShapes);
  const answer: object[] = [];
  let size = 0;
  let next = offset;
  for (; next < ordered.length; next++) {
    const c = ordered[next];
    const entry = {
      id: c.id,
      label: c.label,
      keywords: c.keywords,
      numberOfShapes: c.numberOfShapes,
      bounds: roundClusterBox(c.bounds),
    };
    const entrySize = JSON.stringify(entry).length + 1; // the comma
    if (answer.length > 0 && size + entrySize > PAGE_INFO_MAX_CHARS) break;
    answer.push(entry);
    size += entrySize;
  }

  return toolJsonResult({
    name: pageName,
    bounds: roundClusterBox(pageBounds),
    clusterCount: clusters.length,
    clusters: answer,
    ...(next < ordered.length ? { nextCursor: encodePageInfoCursor(next, selector) } : null),
  });
}

/**
 * The most JSON one get_cluster_info answer carries before it stops and hands back a nextCursor.
 * Some clients cut a tool result off at 25K tokens, and this JSON runs about 2.5 to 3 characters a
 * token, so 60K characters keeps an answer under that. Measured rather than counted in
 * shapes, because a shape's size is mostly its text: a box is ~400 characters, a note holding a
 * paragraph several times that.
 */
export const CLUSTER_INFO_MAX_CHARS = 60_000;

export type ClusterInfoResult =
  | { ok: true; result: ToolResult }
  | { ok: false; reason: "cluster_not_found" | "invalid_input"; result: ToolResult };

export function getClusterInfo(
  { pageName, details, ancestors, bindings, arrows, dimensions }: McpPageRead,
  clusterIds: string[],
  selector: PageSelector,
  cursor: ClusterInfoCursor | null = null,
): ClusterInfoResult {
  const found = findClusters(details, clusterIds, selector);
  if (!found.ok) return { ok: false, reason: "cluster_not_found", result: found.result };

  const start = cursor ?? { cluster: 0, shape: 0 };
  // The ids are checked against the cursor when it is read, and a cluster whose shapes changed has a
  // new id and is refused above, so this catches a cursor that was altered or made up.
  if (start.shape >= (found.clusters[start.cluster]?.shapes.length ?? 0)) {
    return {
      ok: false,
      reason: "invalid_input",
      result: toolError(
        "cursor does not point into these clusters any more. Omit it to start from the first shape.",
      ),
    };
  }

  const pageTransformOf = getPageTransformResolver([
    ...details.flatMap((cluster) => cluster.shapes),
    ...ancestors,
  ]);
  const bindingsByArrow = new Map<string, TLArrowBinding[]>();
  for (const binding of bindings) {
    const existing = bindingsByArrow.get(binding.fromId);
    if (existing) existing.push(binding);
    else bindingsByArrow.set(binding.fromId, [binding]);
  }

  // Fills the answer shape by shape until the next would take it over budget. At least one shape
  // always goes in, so a single shape larger than the budget still gets read and paging moves on.
  // The budget covers the whole answer: across many small clusters, the label and keywords each
  // one carries come to nearly as much again as its shapes. Room is kept for the longest cursor.
  const answered: Record<string, unknown>[] = [];
  const longestCursor = encodeClusterInfoCursor(
    {
      cluster: found.clusters.length,
      shape: Math.max(...found.clusters.map((cluster) => cluster.shapes.length)),
    },
    clusterIds,
  );
  let size = JSON.stringify({
    pageName,
    clusters: [],
    nextCursor: longestCursor,
  }).length;
  let shapeCount = 0;
  let next: ClusterInfoCursor | null = null;
  fill: for (let c = start.cluster; c < found.clusters.length; c++) {
    const cluster = found.clusters[c];
    const firstShape = c === start.cluster ? start.shape : 0;
    const shapes: unknown[] = [];
    for (let s = firstShape; s < cluster.shapes.length; s++) {
      const shape = cluster.shapes[s];
      const readable = toReadableShape(shape, {
        transform: pageTransformOf(shape),
        measuredArrow: arrows[shape.id],
        measuredDimensions: dimensions[shape.id],
        bindings: bindingsByArrow.get(shape.id) ?? [],
      });
      // A slice's own fields are paid for with its first shape, so a cluster left for the next
      // answer costs this one nothing.
      const envelope = shapes.length
        ? 0
        : JSON.stringify(describeClusterSlice(cluster, firstShape, [])).length + 1;
      const shapeSize = envelope + JSON.stringify(readable).length + 1;
      if (shapeCount > 0 && size + shapeSize > CLUSTER_INFO_MAX_CHARS) {
        next = { cluster: c, shape: s };
        if (shapes.length) answered.push(describeClusterSlice(cluster, firstShape, shapes));
        break fill;
      }
      size += shapeSize;
      shapeCount++;
      shapes.push(readable);
    }
    answered.push(describeClusterSlice(cluster, firstShape, shapes));
  }

  return {
    ok: true,
    result: toolJsonResult({
      pageName,
      clusters: answered,
      ...(next ? { nextCursor: encodeClusterInfoCursor(next, clusterIds) } : null),
    }),
  };
}

// A cluster split across answers carries firstShapeIndex, so a model can tell a slice from a whole
// cluster without counting against numberOfShapes, which is always the cluster's total.
function describeClusterSlice(cluster: ShapeCluster, firstShape: number, shapes: unknown[]) {
  const whole = firstShape === 0 && shapes.length === cluster.shapes.length;
  return {
    clusterId: cluster.id,
    label: cluster.label,
    keywords: cluster.keywords,
    numberOfShapes: cluster.numberOfShapes,
    ...(whole ? null : { firstShapeIndex: firstShape }),
    shapes,
  };
}

// Unknown ids refuse the whole call rather than answering for the ones that resolved: a caller asking
// for three clusters and getting two has no way to notice.
function findClusters(
  clusters: ShapeCluster[],
  clusterIds: string[],
  selector: PageSelector,
): { ok: true; clusters: ShapeCluster[] } | { ok: false; result: ToolResult } {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const missing = clusterIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      result: toolError(
        `No cluster on page ${describePageSelector(selector)} with id ${missing.map((id) => `"${id}"`).join(", ")}. Call get_page_info to list this page's clusters.`,
      ),
    };
  }
  return { ok: true, clusters: clusterIds.map((id) => byId.get(id)!) };
}

export type PickedShapes = { ok: true; shapeIds: string[] } | { ok: false; result: ToolResult };

/**
 * The shapes to draw for a `get_cluster_screenshot` call. Separate from the capture itself, which is
 * the route's job: this only says *which* shapes, from ids the model supplied.
 */
export function pickClusterShapes(
  clusters: ShapeCluster[],
  clusterIds: string[],
  selector: PageSelector,
): PickedShapes {
  const found = findClusters(clusters, clusterIds, selector);
  if (!found.ok) return found;

  // Several clusters render as one framed image of their union, which is the point of taking more
  // than one: seeing how they sit relative to each other.
  return {
    ok: true,
    shapeIds: [
      ...new Set(found.clusters.flatMap((cluster) => cluster.shapes.map((shape) => shape.id))),
    ],
  };
}

// The shape as a model can use it. Starting from the stored record:
//
// - Position is in page space. A stored x/y/rotation is relative to the shape's parent, so a shape in
//   a frame or group would otherwise read as sitting somewhere else entirely, with nothing to say so.
//   They are replaced by pageX/pageY/pageRotation; parentId stays, so the hierarchy is still visible.
// - An arrow's props.start/end are where the editor drew its ends, in page space, and
//   props.bindingFromId/bindingToId are the shapes they are bound to. Its pageX/pageY are its drawn
//   start, and it has no pageRotation: its ends already say which way it points. On a bound arrow the
//   record's origin and ends are a placeholder stub, often at the page origin, so none of them come
//   from the record — an unmeasured bound start leaves pageX/pageY null, like props.start.
// - props.w/h are the shape's size as drawn. A geo draws at w by h + growY, so growY is folded into
//   h and dropped rather than left for a model to add a second time. A text's height comes from
//   laying out its text, and a group or a freehand stroke has no size on its record, so those are
//   measured; without a measure they are whatever the record holds.
// - A draw or highlight shape's segments are replaced by props.pointCount. Decoded, the points of a
//   few handwritten words run to thousands of coordinates that still don't say what was drawn; a
//   screenshot does, so the tool description sends a model to get_cluster_screenshot instead.
// - `props.richText` — a ProseMirror document, deeply nested and unreadable — is replaced by the plain
//   string the editor's ShapeUtil.getText reported. A geo shape's label is not in `props` under any
//   key a Worker could find, so without the editor's answer that text is simply invisible.
// - typeName is dropped: every entry is a shape, so it is always "shape".
// - Every number is rounded to thousandths, in the record's own units — radians included, where
//   thousandths are still a fraction of a degree. `meta` is the app's own data and is left exactly as
//   stored.
function toReadableShape(
  shape: TLShapeWithPlainText,
  {
    transform,
    measuredArrow,
    measuredDimensions,
    bindings,
  }: {
    transform: PageTransform;
    measuredArrow: MeasuredArrow | undefined;
    measuredDimensions: MeasuredDimensions | undefined;
    bindings: TLArrowBinding[];
  },
) {
  const {
    plainText,
    id,
    type,
    parentId,
    x: _x,
    y: _y,
    rotation: _rotation,
    opacity,
    props: storedProps,
    typeName: _typeName,
    ...rest
  } = shape;
  const props = { ...(storedProps as Record<string, unknown>) };
  delete props.richText;
  const text = plainText ?? getShapeText(shape);
  if (text) props.text = text;
  else delete props.text;
  if (type === "geo") {
    if (typeof props.growY === "number" && typeof props.h === "number") props.h += props.growY;
    delete props.growY;
  } else if (measuredDimensions) {
    Object.assign(props, measuredDimensions);
  }
  if (type === "draw" || type === "highlight") {
    props.pointCount = countSegmentPoints(props.segments);
    delete props.segments;
  }

  const arrow =
    type === "arrow"
      ? getArrowProps(
          storedProps as { start?: VecModel; end?: VecModel },
          transform,
          measuredArrow,
          bindings,
        )
      : null;
  if (arrow) Object.assign(props, arrow);

  return {
    id,
    type,
    parentId,
    ...(arrow
      ? { pageX: arrow.start?.pageX ?? null, pageY: arrow.start?.pageY ?? null }
      : {
          pageX: toThousandths(transform.x),
          pageY: toThousandths(transform.y),
          pageRotation: toPageRotation(transform.rotation),
        }),
    ...rest,
    opacity: toThousandths(opacity),
    props: roundProps(props),
  };
}

function getArrowProps(
  props: { start?: VecModel; end?: VecModel },
  transform: PageTransform,
  measured: MeasuredArrow | undefined,
  bindings: TLArrowBinding[],
) {
  const bindingOf = (which: "start" | "end") => bindings.find((b) => b.props.terminal === which);
  const terminal = (which: "start" | "end") => {
    // Without a measure — a fixture, or a render page older than this worker — a free end can still
    // be placed from the record, since that is all the editor does with it. A bound end cannot, nor
    // can an end stored before arrows had bindings, which has no x/y and would place at NaN.
    const stored = props[which];
    const point = measured
      ? measured[which]
      : !bindingOf(which) && stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
        ? applyPageTransform(transform, stored)
        : null;
    return point ? { pageX: toThousandths(point.x), pageY: toThousandths(point.y) } : null;
  };
  return {
    start: terminal("start"),
    end: terminal("end"),
    bindingFromId: bindingOf("start")?.toId ?? null,
    bindingToId: bindingOf("end")?.toId ?? null,
  };
}

// A segment is either a base64 path (with no `dim`, a 3D one) or, on a record that predates paths,
// an array of points.
function countSegmentPoints(segments: unknown) {
  if (!Array.isArray(segments)) return 0;
  let count = 0;
  for (const segment of segments as { path?: unknown; points?: unknown; dim?: 2 | 3 }[]) {
    if (typeof segment?.path === "string")
      count += b64Vecs.decodePoints(segment.path, segment.dim).length;
    else if (Array.isArray(segment?.points)) count += segment.points.length;
  }
  return count;
}

function roundProps(value: unknown): unknown {
  if (typeof value === "number") return toThousandths(value);
  if (Array.isArray(value)) return value.map(roundProps);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundProps(item)]));
  }
  return value;
}

// Composed from parent and child, a page rotation can run past a full turn or below zero; reported
// in [0, 2π) like a record's, with a hair under a full turn reading as 0 rather than 6.283.
function toPageRotation(radians: number) {
  const turn = Math.PI * 2;
  const rotation = toThousandths(((radians % turn) + turn) % turn);
  return rotation >= toThousandths(turn) ? 0 : rotation;
}

interface PageTransform {
  x: number;
  y: number;
  rotation: number;
}

function applyPageTransform(transform: PageTransform, point: VecModel): VecModel {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.x + point.x * cos - point.y * sin,
    y: transform.y + point.x * sin + point.y * cos,
  };
}

/**
 * Page transforms composed from the records alone, the way `Editor.getShapePageTransform` composes
 * them: a shape's local transform is its x, y and rotation, applied inside its parent's. That needs
 * no editor, so it works for every shape whether or not it was measured.
 */
function getPageTransformResolver(shapes: TLShape[]) {
  const byId = new Map<string, TLShape>(shapes.map((shape) => [shape.id, shape]));
  const resolved = new Map<string, PageTransform>();
  const resolve = (shape: TLShape, depth: number): PageTransform => {
    const cached = resolved.get(shape.id);
    if (cached) return cached;
    // Bounded, so a cyclic parentId in a corrupt snapshot ends at a shape treated as top-level.
    const parent = depth < 100 ? byId.get(shape.parentId) : undefined;
    const parentTransform = parent && resolve(parent, depth + 1);
    const transform = parentTransform
      ? {
          ...applyPageTransform(parentTransform, shape),
          rotation: parentTransform.rotation + shape.rotation,
        }
      : { x: shape.x, y: shape.y, rotation: shape.rotation };
    resolved.set(shape.id, transform);
    return transform;
  };
  return (shape: TLShape) => resolve(shape, 0);
}

const FILE_BOARD_ID_PROPERTY = {
  type: "string",
  description: "The id of a board, from search_boards.",
};

const BOARD_ID_PROPERTY = {
  type: "string",
  description: "The id of a board, from search_boards.",
};

const PAGE_PROPERTY = {
  type: ["number", "string"],
  description: "The page id or 0-based index from get_board_info. Defaults to 0, the first page.",
  default: 0,
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

/**
 * The same tool with name matching turned off: it lists, and takes no `query`.
 *
 * A separate definition rather than the other one with a sentence appended, because a `query` the
 * caller must not send has no business in the schema — a model handed the argument will use it, and
 * be refused. The scope, ordering and paging wording is the same, since none of that changes.
 */

function getBoardInfoToolDefinition() {
  return {
    name: BOARD_INFO_TOOL_NAME,
    title: "Get tldraw board info",
    description:
      "Returns the metadata for a board: its name, page count, the id, name and index of each page, and the people you can @mention in its comments (their id and name). Call this first, then pass a page to get_page_info.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        boardId: BOARD_ID_PROPERTY,
      },
      required: ["boardId"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

function getPageInfoToolDefinition() {
  return {
    name: PAGE_INFO_TOOL_NAME,
    title: "Get tldraw page info",
    description: `Get the shape clusters on a given page. Shapes are clustered by proximity and arrow linkages: shapes near each other or inside a frame, group or larger shape, and shapes joined by arrows, together with those arrows. Every shape is in exactly one cluster. They’re listed in descending size order, each with an id, a label (its frame name, or else its largest text, the top-left one among equals, then a keyword that sets it apart; one with no text is labelled by what it holds, such as "12 freehand strokes"), keywords drawn from all its text, its shape count, and its page-space bounds {x, y, w, h}, or null when none of its shapes could be measured; the page’s bounds cover all its content. clusterCount is the page’s total. An answer too large for one response stops part-way and carries nextCursor: call again with the same page and that cursor for the rest, or stop once you have what you need. Use the bounds to see which clusters sit near each other without opening them. Handwriting and drawings can only be seen with get_cluster_screenshot. Call before get_cluster_info or get_cluster_screenshot, and pass them cluster ids from here.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        boardId: FILE_BOARD_ID_PROPERTY,
        page: PAGE_PROPERTY,
        cursor: {
          type: "string",
          description:
            "The nextCursor from a previous get_page_info result, to get the next clusters. Omit for the first. Pass the same page with it.",
        },
      },
      required: ["boardId"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

function getClusterInfoToolDefinition() {
  return {
    name: CLUSTER_INFO_TOOL_NAME,
    title: "Get tldraw cluster info",
    description: `Get the metadata and full-detail shape info for one or more clusters from get_page_info: for each, in the order asked, its label, keywords, and every shape it contains. Ask for several clusters in one call rather than one call each. An answer too large for one response stops part-way and carries nextCursor: call again with the same clusterIds and that cursor for the rest. A cluster too large for one answer is split across as many answers as it needs, and each slice carries firstShapeIndex: where the slice starts within the whole cluster. numberOfShapes is always the cluster's total. All positions are in page space, whatever the shape's parent: pageX and pageY are the shape's origin on the page (an arrow's is its drawn start, and null when props.start is), and pageRotation its rotation on the page (arrows have none; their ends say which way they point). parentId still names the frame or group a shape sits in. On an arrow, props.start and props.end are its ends as drawn, each { pageX, pageY } (null for a bound end the editor could not measure), and props.bindingFromId and props.bindingToId are the shapes its start and end are bound to, or null when free. \`props\` holds the rest of the record — size and style in the shape's own unrotated space; w and h are a shape's size as drawn, so a geo's h already includes its label's growth (growY, not reported separately), and a text's, group's or freehand stroke's are measured — with the rich text document replaced by \`props.text\`, the plain string the editor reports, which also surfaces text not stored on the record (a geo shape's label, for instance). Every number is rounded to thousandths, in the record's own units: angles in radians, and values that run 0–1 on the record (opacity, labelPosition and so on) as fractions. \`meta\` is passed through as stored. Draw and highlight shapes give their size and props.pointCount but not their strokes, which can't be read from coordinates: to see what was drawn or written, call get_cluster_screenshot.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        boardId: FILE_BOARD_ID_PROPERTY,
        page: PAGE_PROPERTY,
        clusterIds: {
          type: "array",
          items: { type: "string" },
          maxItems: CLUSTER_INFO_MAX_IDS,
          description:
            "One or more cluster ids from get_page_info. All of them must be on the given page. A bare string is also accepted for a single cluster.",
        },
        cursor: {
          type: "string",
          description:
            "The nextCursor from a previous get_cluster_info result, to get the rest of its answer. Omit for the first. Pass the same clusterIds with it.",
        },
      },
      required: ["boardId", "clusterIds"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

function getApplyOpsToolDefinition() {
  return {
    name: APPLY_OPS_TOOL_NAME,
    title: "Apply ops to a board",
    description: `Edit a board by applying a batch of canvas ops. The board does not have to be open anywhere: the ops run on the server, and anyone who has the board open sees the result at once.

A failing op is reported and the rest still run. The result says what each op did, where shapes landed and what was adjusted. Split large work across calls. Page coordinates: y grows downward.

Ops:
- add: a label (text), note, box, ellipse or shape (any geo), at \`at\` (top-left) or relative to a \`target\` (\`relation\`, \`gap\`, \`align\`). A box sizes to its text unless given w/h. Its text is its label, drawn inside it; use \\n for line breaks.
- place: move a shape (\`at\`, or \`relation\` + \`target\`) and/or change its w, h, text and style.
- label: a text label on a shape or a page point, optionally with an arrow.
- connect: an arrow between two shapes (bound to them) or points. Reusing an arrow's id replaces it.
- rename, restyle (or \`like\` another shape), resize, remove, untangle (spread overlapping shapes).
- path: a polyline or curve through page points. closed: true makes a fillable outline.
- duplicate: copy a shape to a new position.

Refer to shapes by id, {text}, {description}, {selected: true} or {created: "last" | index}. Give new shapes short ids so later ops can refer to them.

Put a card's words in the box's own text, not in labels laid over it. Keep shapes from overlapping unless one sits inside another. Change only what the request asks for.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        boardId: FILE_BOARD_ID_PROPERTY,
        ops: {
          ...CANVAS_OPS_BATCH_JSON_SCHEMA.properties.ops,
          minItems: 1,
          description: "The ops to apply, in order.",
        },
        page: {
          type: ["number", "string"],
          description:
            "The page you mean to edit: its 0-based index or page id from get_board_info. Defaults to 0, the first page; on a board with several pages, pass the page id.",
        },
        runId: {
          type: "string",
          description:
            "Any string. Reuse it across calls so {created} refs reach shapes made in earlier calls.",
        },
      },
      required: ["boardId", "ops"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

// CHANGED from upstream: the list holds only the tools this server adapts.
export function getToolDefinitions() {
  return [
    getBoardInfoToolDefinition(),
    getPageInfoToolDefinition(),
    getClusterInfoToolDefinition(),
    getApplyOpsToolDefinition(),
  ];
}

function toClusterBounds({ x, y, w, h }: BoxModel): ClusterBounds {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}
