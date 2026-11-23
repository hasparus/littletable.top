import { z } from "zod";

// The vocabulary of apply_ops: the same op names, field names, enums and
// limits as tldraw's hosted board tools, so an assistant that knows one
// knows the other. Our own schema and wording; the engine (engine.ts) is
// ours too.

export const MAX_OPS = 1000;
export const MAX_TEXT = 5000;

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const extent = z.number().positive().max(100_000);
const gap = z.number().min(0).max(10_000);
const text = z.string().max(MAX_TEXT);
const short = z.string().min(1).max(200);

export const point = z.strictObject({ x: coordinate, y: coordinate });

export const shapeKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/u, "Use letters, digits, ':', '_' and '-' only.")
  .describe("A shape id, with or without its 'shape:' prefix.");

export const color = z.enum([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
]);
export const fill = z.enum(["none", "semi", "solid", "pattern", "fill"]);
export const dash = z.enum(["draw", "solid", "dashed", "dotted"]);
export const size = z.enum(["s", "m", "l", "xl"]);
export const geo = z.enum([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "star",
  "cloud",
  "heart",
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "x-box",
  "check-box",
]);
export const relation = z.enum(["above", "below", "left_of", "right_of", "inside", "centered_on"]);
export const align = z.enum(["start", "center", "end"]);

export const ref = z.union([
  shapeKey,
  z.strictObject({ text: short }).describe("The one shape whose text is this."),
  z.strictObject({ selected: z.literal(true) }).describe("The shape the user has selected."),
  z
    .strictObject({ created: z.union([z.literal("last"), z.int().min(0)]) })
    .describe("A shape made earlier in this run: the last one, or by its position."),
  z
    .strictObject({ description: short })
    .describe('Words such as "the red ellipse in the lower right".'),
]);

export const refList = z.union([
  z.array(ref).min(1).max(200),
  z.strictObject({ selected: z.literal(true) }),
  z.strictObject({ created: z.literal("all") }),
  z.strictObject({ text: short }).describe("Every shape whose text is this."),
]);

export const targetOrPoint = z.union([ref, z.strictObject({ point })]);

const style = {
  color: color.optional(),
  dash: dash.optional(),
  fill: fill.optional(),
  size: size.optional(),
};
const placement = {
  align: align.optional(),
  at: point.optional().describe("Top-left corner in page coordinates."),
  gap: gap.optional(),
  relation: relation.optional(),
  target: ref.optional(),
};

const add = z.strictObject({
  geo: geo.optional(),
  h: extent.optional(),
  id: shapeKey.optional(),
  kind: z.enum(["label", "note", "box", "ellipse", "shape"]).optional(),
  op: z.literal("add"),
  text: text.optional(),
  w: extent.optional(),
  ...style,
  ...placement,
});

const place = z.strictObject({
  op: z.literal("place"),
  subject: ref,
  ...placement,
  h: extent.optional(),
  text: text.optional(),
  w: extent.optional(),
  ...style,
});

const label = z.strictObject({
  arrow: z.boolean().optional(),
  color: color.optional(),
  gap: gap.optional(),
  id: shapeKey.optional(),
  op: z.literal("label"),
  side: z.enum(["above", "below", "left", "right", "auto"]).optional(),
  size: size.optional(),
  target: targetOrPoint,
  text,
});

const connect = z.strictObject({
  color: color.optional(),
  dash: dash.optional(),
  from: targetOrPoint,
  id: shapeKey.optional(),
  op: z.literal("connect"),
  text: text.optional(),
  to: targetOrPoint,
});

const rename = z.strictObject({
  fit: z.enum(["widen", "shrink_text"]).optional(),
  op: z.literal("rename"),
  target: ref,
  text,
});

const restyle = z.strictObject({
  op: z.literal("restyle"),
  targets: refList,
  ...style,
  like: ref.optional(),
});

const remove = z.strictObject({ op: z.literal("remove"), targets: refList });

const untangle = z.strictObject({
  keepNear: z.array(ref).max(200).optional(),
  maxDistance: z.number().positive().max(2000).optional(),
  op: z.literal("untangle"),
  targets: refList,
});

const resize = z.strictObject({
  anchor: z.enum(["top-left", "center"]).optional(),
  h: extent.optional(),
  op: z.literal("resize"),
  scale: z.number().positive().max(100).optional(),
  target: ref,
  w: extent.optional(),
});

const path = z.strictObject({
  closed: z.boolean().optional(),
  id: shapeKey.optional(),
  op: z.literal("path"),
  points: z.array(point).min(2).max(256),
  smooth: z.boolean().optional(),
  ...style,
});

const duplicate = z.strictObject({
  at: point,
  id: shapeKey.optional(),
  op: z.literal("duplicate"),
  subject: ref,
  text: text.optional(),
});

export const op = z.discriminatedUnion("op", [
  add,
  place,
  label,
  connect,
  rename,
  restyle,
  remove,
  untangle,
  resize,
  path,
  duplicate,
]);

export const opsBatch = z.array(op).min(1).max(MAX_OPS);

export type Op = z.infer<typeof op>;
export type Ref = z.infer<typeof ref>;
export type RefList = z.infer<typeof refList>;
export type TargetOrPoint = z.infer<typeof targetOrPoint>;
export type Point = z.infer<typeof point>;

export type OpResult = {
  /** What the engine changed to keep the op's promise, e.g. a nudge clear of a neighbour. */
  adjusted?: string;
  index: number;
  message: string;
  ok: boolean;
  op: Op["op"];
  shapeIds: string[];
};

export type ApplyOpsResult = {
  applied: number;
  batchId: string;
  errors: string[];
  pageId: string;
  pageName: string;
  results: OpResult[];
};
