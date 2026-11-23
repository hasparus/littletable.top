// The numerals of one die kind, drawn once on a canvas: white, with black
// ink, one cell per face (dice-mesh.ts lays the cells out). The renderer
// colours body and ink itself, so one atlas serves every look.

import { add, dot, length, normalize, scale, sub, type Vec } from "./dice-math";
import { cellPoint, type Layout, layoutOf } from "./dice-mesh";
import { type DieKind, solid, type Solid } from "./dice-solids";

// NOTE: the caller loads this font before drawing (dice-scene.ts); a canvas
// does not wait for a font and would draw the fallback for good.
export const NUMERAL_FONT = '700 64px "Outfit"';

const CELL_PX = 192;

// A digit's height and a numeral's greatest width, as shares of the radius
// of the circle inscribed in its face; every numeral of a die is the size of
// the one these leave the least room. A d4's three numerals share a face.
const DIGIT_HEIGHT = 0.92;
const D4_DIGIT_HEIGHT = 0.86;
const NUMERAL_WIDTH = 1.4;
// How far from a d4 face's middle to its corner a numeral sits.
const D4_REACH = 0.54;
// The line that tells a 6 from a 9, in digit heights: its gap, its
// thickness, and its width as a share of the digit's.
const LINE = { gap: 0.13, thick: 0.13, wide: 0.9 };

// How far `p` is from the line through `from` and `to`.
function toLine(p: Vec, from: Vec, to: Vec): number {
  const edge = sub(to, from);
  const along = dot(sub(p, from), edge) / dot(edge, edge);
  return length(sub(add(from, scale(edge, along)), p));
}

// The middle and radius of the circle inscribed in a face of the rounded
// die. A regular face has it at its centre; a kite has it on its axis where
// an edge at the pole and an edge at the blunt end are equally far.
function inscribed(shape: Solid, index: number, layout: Layout): { at: Vec; radius: number } {
  const face = shape.faces[index]!;
  const corner = (v: number) => add(shape.core[v]!, scale(face.normal, shape.r));
  const { center } = layout.cells[index]!;
  if (shape.kind !== "d10" && shape.kind !== "d100") {
    return { at: center, radius: toLine(center, corner(face.verts[0]!), corner(face.verts[1]!)) };
  }
  const byHeight = face.verts.toSorted(
    (a, b) => Math.abs(shape.verts[b]![1]) - Math.abs(shape.verts[a]![1]),
  );
  const pole = corner(byHeight[0]!);
  const [side, , blunt] = byHeight
    .slice(1)
    .map(corner)
    .toSorted((a, b) => length(sub(a, pole)) - length(sub(b, pole))) as [Vec, Vec, Vec];
  // The distance to the pole's edge grows along the axis as fast as the
  // distance to the blunt end's edge shrinks from there.
  const fromPole = toLine(blunt, pole, side);
  const fromBlunt = toLine(pole, side, blunt);
  const share = fromBlunt / (fromPole + fromBlunt);
  return { at: add(pole, scale(sub(blunt, pole), share)), radius: fromPole * share };
}

type Pen = { context: CanvasRenderingContext2D; layout: Layout };

// The ink of `text` at 100px, from the font's own outlines: its box around
// the point the text is centred on, and that box with the line under a 6 or
// a 9 added.
function inkOf(context: CanvasRenderingContext2D, text: string) {
  context.font = '700 100px "Outfit"';
  const box = context.measureText(text);
  const lined = text === "6" || text === "9";
  const height = box.actualBoundingBoxAscent;
  return {
    bottom: lined ? height * (LINE.gap + LINE.thick) : box.actualBoundingBoxDescent,
    height,
    left: box.actualBoundingBoxLeft,
    lined,
    right: box.actualBoundingBoxRight,
  };
}

// Writes `text` with the middle of its ink's box, line included, on `at`.
function write(
  { context, layout }: Pen,
  { at, face, size, text, up }: { at: Vec; face: number; size: number; text: string; up: Vec },
) {
  const cell = layout.cells[face]!;
  const [x, y] = cellPoint(layout, face, at);
  const ink = inkOf(context, text);
  const unit = size / 100;
  context.save();
  context.translate(x * CELL_PX, y * CELL_PX);
  context.rotate(Math.atan2(dot(up, cell.right), dot(up, cell.up)));
  context.translate(((ink.left - ink.right) / 2) * unit, ((ink.height - ink.bottom) / 2) * unit);
  context.font = `700 ${size}px "Outfit"`;
  context.fillText(text, 0, 0);
  if (ink.lined) {
    const middle = (ink.right - ink.left) / 2;
    const wide = (ink.left + ink.right) * LINE.wide;
    context.fillRect(
      (middle - wide / 2) * unit,
      ink.height * LINE.gap * unit,
      wide * unit,
      ink.height * LINE.thick * unit,
    );
  }
  context.restore();
}

// The font size at which no numeral of `texts` outgrows a face whose
// inscribed circle has `radius` pixels.
function sizeFor(context: CanvasRenderingContext2D, texts: string[], radius: number, tall: number) {
  return Math.min(
    ...texts.map((text) => {
      const ink = inkOf(context, text);
      return Math.min(
        (radius * tall * 100) / ink.height,
        (radius * NUMERAL_WIDTH * 100) / (ink.left + ink.right),
      );
    }),
  );
}

export function drawAtlas(kind: DieKind): HTMLCanvasElement {
  const shape = solid(kind);
  const layout = layoutOf(shape);
  const canvas = document.createElement("canvas");
  canvas.width = layout.columns * CELL_PX;
  canvas.height = layout.columns * CELL_PX;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2D canvas for the dice numerals");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.textAlign = "center";
  const pen: Pen = { context, layout };
  const size = sizeFor(
    context,
    shape.features.map(({ text }) => text),
    (inscribed(shape, 0, layout).radius / layout.cells[0]!.span) * CELL_PX,
    kind === "d4" ? D4_DIGIT_HEIGHT : DIGIT_HEIGHT,
  );

  for (const [index, face] of shape.faces.entries()) {
    const cell = layout.cells[index]!;
    if (kind === "d4") {
      // Each corner's number on all three faces around it: the one on top is
      // read off any side.
      for (const v of face.verts) {
        const out = sub(add(shape.core[v]!, scale(face.normal, shape.r)), cell.center);
        write(pen, {
          at: add(cell.center, scale(out, D4_REACH)),
          face: index,
          size,
          text: String(v + 1),
          up: normalize(out),
        });
      }
      continue;
    }
    write(pen, {
      at: inscribed(shape, index, layout).at,
      face: index,
      size,
      text: shape.features[index]!.text,
      up: cell.up,
    });
  }
  return canvas;
}
