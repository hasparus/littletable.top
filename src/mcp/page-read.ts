import type { TLArrowBinding, TLArrowShape, TLPage, TLShape } from "@tldraw/tlschema";

import type { Doc } from "../ops/doc";

import { closeness, excerpt, fold, oneLine } from "../../client/src/search-text";
import { apply, arrowPath, localBounds, pageBounds, pageTransform } from "../ops/geometry";
import { textOf } from "../ops/records";
import { type McpPageRead, readMcpPage, toShapeMeasurements } from "./upstream/shared/mcpPageRead";
import { type ThumbnailShapeMeasurement } from "./upstream/shared/types";

// What tldraw's page-read code asks an editor in a browser tab for, worked
// out here from the records: each shape's page box, its text, an arrow's
// drawn ends, and the size of shapes whose record does not hold one.

const MEASURED_SIZE = new Set(["draw", "group", "highlight", "text"]);

function measure(doc: Doc, shape: TLShape): ThumbnailShapeMeasurement {
  const box = pageBounds(doc, shape);
  const text = textOf(shape);
  const out: ThumbnailShapeMeasurement = { h: box.h, w: box.w, x: box.x, y: box.y };
  if (text !== "") out.text = text;
  if (shape.type === "arrow") {
    const course = arrowPath(doc, shape as TLArrowShape);
    const toPage = pageTransform(doc, shape);
    if (course.length >= 2) {
      out.arrow = { end: apply(toPage, course.at(-1)!), start: apply(toPage, course[0]!) };
    }
  }
  if (MEASURED_SIZE.has(shape.type)) {
    const { h, w } = localBounds(doc, shape);
    out.dimensions = { h, w };
  }
  return out;
}

export function readPage(doc: Doc, page: TLPage, clusterIds: readonly string[]): McpPageRead {
  const shapes = doc.shapesOnPage(page.id);
  const ids = new Set<string>(shapes.map((shape) => shape.id));
  const bindings: TLArrowBinding[] = [];
  for (const record of doc.records()) {
    if (record.typeName === "binding" && record.type === "arrow" && ids.has(record.fromId)) {
      bindings.push(record as TLArrowBinding);
    }
  }
  const reported = Object.fromEntries(shapes.map((shape) => [shape.id, measure(doc, shape)]));
  return readMcpPage({
    bindings,
    clusterIds,
    measurements: toShapeMeasurements(reported),
    pageId: page.id,
    pageName: page.name,
    shapes,
  });
}

export type ShapeMatch = {
  bounds: { h: number; w: number; x: number; y: number };
  confidence: number;
  excerpt: string;
  pageId: string;
  shapeId: string;
  source: "native";
};

// NOTE: the same folding, ranking and excerpts as the board's own search
// sheet (client/src/search-text.ts, pure text code), so "zolw" finds "żółw"
// here as it does there. The sheet's index (typos, prefixes) is not used.
export function searchShapes(doc: Doc, query: string, pageId: string | null): ShapeMatch[] {
  const words = fold(oneLine(query)).split(" ").filter(Boolean);
  const found: { closeness: number; match: ShapeMatch }[] = [];
  for (const page of doc.pages()) {
    if (pageId !== null && page.id !== pageId) continue;
    for (const shape of doc.shapesOnPage(page.id)) {
      const text = textOf(shape);
      const folded = fold(text);
      if (text === "" || words.length === 0 || !words.every((word) => folded.includes(word))) {
        continue;
      }
      const box = pageBounds(doc, shape);
      found.push({
        closeness: closeness(query, text),
        match: {
          bounds: {
            h: Math.round(box.h),
            w: Math.round(box.w),
            x: Math.round(box.x),
            y: Math.round(box.y),
          },
          confidence: 1,
          excerpt: excerpt(text, query, words)
            .map((part) => part.text)
            .join(""),
          pageId: page.id,
          shapeId: shape.id.replace(/^shape:/u, ""),
          source: "native",
        },
      });
    }
  }
  return found.sort((a, b) => b.closeness - a.closeness).map(({ match }) => match);
}
