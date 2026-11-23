import {
  createBindingId,
  createShapeId,
  createTLSchema,
  type TLArrowBinding,
  type TLParentId,
  type TLRecord,
  type TLRichText,
  type TLShape,
  type TLShapeId,
} from "@tldraw/tlschema";
import { type IndexKey } from "@tldraw/utils";

// Builds records exactly as tldraw 5.6 stores them (every prop its schema
// requires, at the current version), and checks each one against that
// schema before the room sees it.

const schema = createTLSchema();

export class InvalidRecord extends Error {}

export function validate(record: TLRecord, before?: TLRecord): void {
  const type = (schema.types as Record<string, { validate: (r: unknown, b?: unknown) => unknown }>)[
    record.typeName
  ];
  if (type === undefined) throw new InvalidRecord(`no record type ${record.typeName}`);
  try {
    type.validate(record, before);
  } catch (error) {
    throw new InvalidRecord(`${record.id}: ${(error as Error).message}`);
  }
}

/** A model's shape key ("castle" or "shape:castle") as a shape id. */
export const toShapeId = (key: string): TLShapeId =>
  (key.startsWith("shape:") ? key : createShapeId(key)) as TLShapeId;

/** A shape id as the model sees it: without its prefix. */
export const fromShapeId = (id: string): string => id.replace(/^shape:/u, "");

type RichNode = { content?: unknown[]; text?: string; type: string };

function visit(node: RichNode, line: string[]) {
  if (node.type === "text") line.push(node.text ?? "");
  else if (node.type === "hardBreak") line.push("\n");
  for (const child of (node.content ?? []) as RichNode[]) visit(child, line);
}

export function plainText(richText: TLRichText | undefined): string {
  if (richText === undefined) return "";
  const lines: string[] = [];
  for (const block of richText.content as RichNode[]) {
    const line: string[] = [];
    visit(block, line);
    lines.push(line.join(""));
  }
  return lines.join("\n");
}

/** A shape's text, whichever prop holds it. */
export function textOf(shape: TLShape): string {
  const props = shape.props as { name?: string; richText?: TLRichText };
  if (shape.type === "frame") return props.name ?? "";
  return plainText(props.richText);
}

export { toRichText } from "@tldraw/tlschema";

type Base = {
  id: TLShapeId;
  index: IndexKey;
  meta: Record<string, unknown>;
  parentId: TLParentId;
  x: number;
  y: number;
};

const shapeBase = (base: Base) => ({
  ...base,
  isLocked: false,
  opacity: 1,
  rotation: 0,
  typeName: "shape" as const,
});

type Style = { color: string; dash: string; fill: string; font: string; size: string };

export function geoRecord(
  base: Base,
  p: Style & { geo: string; growY: number; h: number; richText: TLRichText; w: number },
): TLShape {
  return {
    ...shapeBase(base),
    props: {
      align: "middle",
      color: p.color,
      dash: p.dash,
      fill: p.fill,
      flipX: false,
      flipY: false,
      font: p.font,
      geo: p.geo,
      growY: p.growY,
      h: p.h,
      labelColor: "black",
      richText: p.richText,
      scale: 1,
      size: p.size,
      url: "",
      verticalAlign: "middle",
      w: p.w,
    },
    type: "geo",
  } as TLShape;
}

export function noteRecord(
  base: Base,
  p: Pick<Style, "color" | "font" | "size"> & {
    fontSizeAdjustment: number;
    growY: number;
    richText: TLRichText;
  },
): TLShape {
  return {
    ...shapeBase(base),
    props: {
      align: "middle",
      color: p.color,
      font: p.font,
      fontSizeAdjustment: p.fontSizeAdjustment,
      growY: p.growY,
      labelColor: "black",
      richText: p.richText,
      scale: 1,
      size: p.size,
      textLastEditedBy: null,
      url: "",
      verticalAlign: "middle",
    },
    type: "note",
  } as TLShape;
}

export function textRecord(
  base: Base,
  p: Pick<Style, "color" | "font" | "size"> & {
    autoSize: boolean;
    richText: TLRichText;
    w: number;
  },
): TLShape {
  return {
    ...shapeBase(base),
    props: {
      autoSize: p.autoSize,
      color: p.color,
      font: p.font,
      richText: p.richText,
      scale: 1,
      size: p.size,
      textAlign: "start",
      w: p.w,
    },
    type: "text",
  } as TLShape;
}

export function arrowRecord(
  base: Base,
  p: Pick<Style, "color" | "dash" | "font" | "size"> & {
    end: { x: number; y: number };
    richText: TLRichText;
  },
): TLShape {
  return {
    ...shapeBase(base),
    props: {
      arrowheadEnd: "arrow",
      arrowheadStart: "none",
      bend: 0,
      color: p.color,
      dash: p.dash,
      elbowMidPoint: 0.5,
      end: p.end,
      fill: "none",
      font: p.font,
      kind: "arc",
      labelColor: "black",
      labelPosition: 0.5,
      richText: p.richText,
      scale: 1,
      size: p.size,
      start: { x: 0, y: 0 },
    },
    type: "arrow",
  } as TLShape;
}

// NOTE: an imprecise binding points the arrow at the shape's centre, and
// tldraw draws it up to the shape's outline, wherever the shape goes.
export function arrowBindingRecord(
  arrowId: TLShapeId,
  toId: TLShapeId,
  terminal: "end" | "start",
): TLArrowBinding {
  return {
    fromId: arrowId,
    id: createBindingId(),
    meta: {},
    props: {
      isExact: false,
      isPrecise: false,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      snap: "none",
      terminal,
    },
    toId,
    type: "arrow",
    typeName: "binding",
  } as TLArrowBinding;
}
