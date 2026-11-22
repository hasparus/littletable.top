// The numerals of one die kind, drawn once on a canvas: white, with black
// ink, one cell per face (dice-mesh.ts lays the cells out). The renderer
// colours body and ink itself, so one atlas serves every look.

import { add, dot, length, normalize, scale, sub, type Vec } from "./dice-math";
import { cellPoint, type Layout, layoutOf } from "./dice-mesh";
import { type DieKind, type Face, solid, type Solid } from "./dice-solids";

// NOTE: the caller loads this font before drawing (dice-scene.ts); a canvas
// does not wait for a font and would draw the fallback for good.
export const NUMERAL_FONT = '700 64px "Outfit"';

const CELL_PX = 192;

// The numeral's height as a share of the circle inscribed in its face.
const HEIGHT: Record<DieKind, number> = {
  d4: 1.25,
  d6: 1.35,
  d8: 1.4,
  d10: 1.1,
  d12: 1.2,
  d20: 1.25,
  d100: 0.95,
};
// How much of that circle's radius a numeral may span across.
const WIDTH = 1.75;
const KITE_WIDTH = 1.55;
const CAP_HEIGHT = 0.7;

// The radius of the circle inscribed in a face of the rounded die.
function inscribed(shape: Solid, face: Face, shrink: number): number {
  const distances = face.verts.map((v, k) => {
    const from = shape.verts[v]!;
    const edge = sub(shape.verts[face.verts[(k + 1) % face.verts.length]!]!, from);
    const along = dot(sub(face.center, from), edge) / dot(edge, edge);
    return length(sub(add(from, scale(edge, along)), face.center));
  });
  return Math.min(...distances) * shrink;
}

type Pen = { context: CanvasRenderingContext2D; layout: Layout };

function write(
  { context, layout }: Pen,
  { at, face, size, text, up }: { at: Vec; face: number; size: number; text: string; up: Vec },
) {
  const cell = layout.cells[face]!;
  const [x, y] = cellPoint(layout, face, at);
  const baseline = (size * CAP_HEIGHT) / 2;
  context.save();
  context.translate(x * CELL_PX, y * CELL_PX);
  context.rotate(Math.atan2(dot(up, cell.right), dot(up, cell.up)));
  context.font = `700 ${size}px "Outfit"`;
  context.fillText(text, 0, baseline);
  // A 6 and a 9 are told apart by the line under them.
  if (text === "6" || text === "9") {
    const { width } = context.measureText(text);
    context.fillRect(-width * 0.38, baseline + size * 0.1, width * 0.76, size * 0.09);
  }
  context.restore();
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
  const kite = kind === "d10" || kind === "d100";

  for (const [index, face] of shape.faces.entries()) {
    const cell = layout.cells[index]!;
    const radius = (inscribed(shape, face, layout.shrink) / cell.span) * CELL_PX;
    const corner = (v: number) => add(shape.core[v]!, scale(face.normal, shape.r));
    if (kind === "d4") {
      // Each corner's number on all three faces around it: the one on top is
      // read off any side.
      for (const v of face.verts) {
        const out = sub(corner(v), cell.center);
        write(pen, {
          at: add(cell.center, scale(out, 0.54)),
          face: index,
          size: radius * HEIGHT.d4,
          text: String(v + 1),
          up: normalize(out),
        });
      }
      continue;
    }
    let at = cell.center;
    if (kite) {
      // A kite's widest part is nearer its blunt end; the numeral sits there.
      const blunt = face.verts
        .filter((v) => Math.abs(shape.verts[v]![1]) < 0.5)
        .toSorted(
          (a, b) =>
            length(sub(shape.verts[b]!, face.center)) - length(sub(shape.verts[a]!, face.center)),
        )[0]!;
      at = add(cell.center, scale(sub(corner(blunt), cell.center), 0.12));
    }
    const { text } = shape.features[index]!;
    context.font = '700 100px "Outfit"';
    const widthAt100 = context.measureText(text).width;
    const size = Math.min(
      radius * HEIGHT[kind],
      ((radius * (kite ? KITE_WIDTH : WIDTH)) / widthAt100) * 100,
    );
    write(pen, { at, face: index, size, text, up: cell.up });
  }
  return canvas;
}
