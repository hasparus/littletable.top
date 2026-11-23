// Adapted from tldraw: packages/dotcom-shared/src/types.ts at commit ebe1433
// (an excerpt: only what the page-read code uses). Copyright (c) tldraw Inc.
// Used with permission; what was changed is listed in
// docs/upstream-provenance.md.

import type { BoxModel, VecModel } from "@tldraw/tlschema";

/**
 * The most pages the board-info tool will enumerate for a board. Bounds the page list the MCP
 * server returns and the valid page-ordinal range for screenshots.
 */
export const MAX_THUMBNAIL_PAGES = 40;

/**
 * An arrow as drawn, in page space. Only an editor can say: a bound arrow's record stores a
 * placeholder stub, and its real ends depend on the geometry of the shapes it is bound to.
 */
export interface MeasuredArrow {
  start: VecModel;
  end: VecModel;
}

/**
 * A shape's own unrotated size as the editor draws it. The record cannot say: a text's height comes
 * from laying out its text, and a group or a freehand stroke has no size of its own.
 */
export type MeasuredDimensions = Pick<BoxModel, "w" | "h">;

/**
 * What the editor reports for one shape: its page-space box, the plain text its ShapeUtil says it
 * holds, for an arrow where it is drawn, and for some shapes their own size.
 */
export interface ThumbnailShapeMeasurement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** `ShapeUtil.getText(shape)`, absent when the shape has no text. */
  text?: string;
  /** An arrow's drawn ends, in page space. */
  arrow?: MeasuredArrow;
  /** A text, group, draw or highlight shape's own unrotated size as drawn, unlike the page box. */
  dimensions?: MeasuredDimensions;
}
