import type { TLArrowShape } from "@tldraw/tlschema";

import { type Vec } from "../../ops/geometry";
import { arrowPath } from "../../ops/geometry";
import { type StandInEditor } from "./editor";

// What tldraw's canvas-ops engine imports from "tldraw", for a Worker with
// no browser: the record helpers come from tldraw's MIT packages, and
// `Editor` is our stand-in. The adapted engine (../upstream/canvas-ops)
// imports this module where the original imports "tldraw".

export { Box } from "./editor";
export {
  b64Vecs,
  createBindingId,
  createShapeId,
  DefaultFontFamilies,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDrawShape,
  type TLGeoShape,
  type TLLineShape,
  type TLNoteShape,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLTextShape,
  toRichText,
} from "@tldraw/tlschema";
export { getIndices, uniqueId } from "@tldraw/utils";

export type Editor = StandInEditor;

/** Whether two rotations differ by a multiple of a quarter turn. */
export function areAnglesCompatible(a: number, b: number): boolean {
  const d = Math.abs(a - b) % (Math.PI / 2);
  return Math.abs(d) < 0.000_001 || Math.abs(d - Math.PI / 2) < 0.000_001;
}

/** Where an arrow's drawn ends are, in its own space. */
export function getArrowInfo(
  editor: StandInEditor,
  arrow: TLArrowShape,
): { end: { point: Vec }; start: { point: Vec } } | undefined {
  const course = arrowPath(editor.doc, arrow);
  if (course.length < 2) return undefined;
  return { end: { point: course.at(-1)! }, start: { point: course[0]! } };
}
