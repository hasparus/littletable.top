// The numerals of one die kind, drawn once on a canvas: white, with black
// ink, one cell per face (dice-mesh.ts lays the cells out). The renderer
// colours body and ink itself, so one atlas serves every look.

import { add, dot, length, normalize, scale, sub, type Vec } from "./dice-math";
import { cellPoint, type Layout, layoutOf } from "./dice-mesh";
import { DIGIT_INK, DIGIT_TOP } from "./dice-numeral-centres";
import { type DieKind, solid, type Solid } from "./dice-solids";

export const NUMERAL_FONT = '700 64px "Outfit"';

const CELL_PX = 192;
const BALL_CELL_PX = 96;

// A digit's height and a numeral's greatest width, as shares of the radius
// of the circle inscribed in its face; every numeral of a die is the size of
// the one these leave the least room. A d4's three numerals share a face.
const DIGIT_HEIGHT = 0.92;
const D4_DIGIT_HEIGHT = 0.86;
const NUMERAL_WIDTH = 1.4;
// How far from a d4 face's middle to its corner a numeral sits.
const D4_REACH = 0.54;
// The line under a numeral that reads as another one upside down, in digit
// heights: its gap, its thickness, its width as a share of the numeral's,
// and how much of it counts when the numeral is centred up and down: all of
// it pushes the digit up, none of it leaves the mark hanging low.
const LINE = { counts: 0.5, gap: 0.11, thick: 0.11, wide: 0.9 };
// Across, a numeral sits this share of the way from the middle of its ink's
// box to its ink's centre of mass. All the way looks right for a 1 and a
// touch too far for an open 3.
const BY_MASS = 0.75;
const TURNED: Record<string, string> = { 0: "0", 1: "1", 6: "9", 8: "8", 9: "6" };

// The numerals of `texts` that need the line: those that, upside down, read
// as a different numeral of the same die. A d6 or a d8 has a 6 and no 9, so
// neither is lined.
function linedOf(texts: string[]): Set<string> {
  return new Set(
    texts.filter((text) => {
      const turned = [...text].toReversed().map((digit) => TURNED[digit]);
      const other = turned.join("");
      return (
        turned.every((digit) => digit !== undefined) && other !== text && texts.includes(other)
      );
    }),
  );
}

// How far `p` is from the line through `from` and `to`.
function toLine(p: Vec, from: Vec, to: Vec): number {
  const edge = sub(to, from);
  const along = dot(sub(p, from), edge) / dot(edge, edge);
  return length(sub(add(from, scale(edge, along)), p));
}

// The middle and radius of the circle inscribed in a face of the rounded
// die. A regular face has it at its centre; a kite has it on its axis where
// an edge at the pole and an edge at the blunt end are equally far; a ball's
// faces are uneven, and theirs is searched for from the face's middle.
function inscribed(shape: Solid, index: number, layout: Layout): { at: Vec; radius: number } {
  const face = shape.faces[index]!;
  const corner = (v: number) => add(shape.core[v]!, scale(face.normal, shape.r));
  if (shape.kind !== "d10") {
    const corners = face.verts.map(corner);
    const room = (p: Vec) =>
      Math.min(...corners.map((from, k) => toLine(p, from, corners[(k + 1) % corners.length]!)));
    const { center, right, up } = layout.cells[index]!;
    let at = center;
    for (let step = shape.ball ? room(at) / 2 : 0; step > 1e-4; ) {
      const ways = [right, up, add(right, up), sub(right, up)];
      const better = [...ways, ...ways.map((way) => scale(way, -1))]
        .map((way) => add(at, scale(way, step * 0.7)))
        .find((p) => room(p) > room(at));
      if (better === undefined) step /= 2;
      else at = better;
    }
    return { at, radius: room(at) };
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

type Pen = {
  cellPx: number;
  context: CanvasRenderingContext2D;
  layout: Layout;
  lined: Set<string>;
};

// Where the ink of `text` is at 100px, around the point the text is centred
// on. Across, a numeral is placed by its ink's centre of mass (a 1 is heavy
// on its right, so the middle of its box is not where it looks centred), from
// the table of the font's digits, tempered by BY_MASS. Up and down, by the
// height all digits share, so numerals on dice side by side keep one line.
function inkOf(context: CanvasRenderingContext2D, text: string, lined: boolean) {
  context.font = '700 100px "Outfit"';
  const box = context.measureText(text);
  let mass = 0;
  let moment = 0;
  for (const [index, digit] of [...text].entries()) {
    const { area, x } = DIGIT_INK[digit]!;
    const origin =
      context.measureText(text.slice(0, index + 1)).width -
      context.measureText(digit).width -
      box.width / 2;
    mass += area;
    moment += area * (origin + x * 100);
  }
  const height = DIGIT_TOP * 100;
  return {
    centre:
      (moment / mass) * BY_MASS +
      ((box.actualBoundingBoxRight - box.actualBoundingBoxLeft) / 2) * (1 - BY_MASS),
    height,
    left: box.actualBoundingBoxLeft,
    lined,
    lineDrop: lined ? height * (LINE.gap + LINE.thick) * LINE.counts : 0,
    right: box.actualBoundingBoxRight,
  };
}

function write(
  { cellPx, context, layout, lined }: Pen,
  { at, face, size, text, up }: { at: Vec; face: number; size: number; text: string; up: Vec },
) {
  const cell = layout.cells[face]!;
  const [x, y] = cellPoint(layout, face, at);
  const ink = inkOf(context, text, lined.has(text));
  const unit = size / 100;
  context.save();
  context.translate(x * cellPx, y * cellPx);
  context.rotate(Math.atan2(dot(up, cell.right), dot(up, cell.up)));
  context.translate(-ink.centre * unit, ((ink.height - ink.lineDrop) / 2) * unit);
  context.font = `700 ${size}px "Outfit"`;
  context.fillText(text, 0, 0);
  if (ink.lined) {
    const wide = (ink.left + ink.right) * LINE.wide;
    context.fillRect(
      ((ink.right - ink.left) / 2 - wide / 2) * unit,
      ink.height * LINE.gap * unit,
      wide * unit,
      ink.height * LINE.thick * unit,
    );
  }
  context.restore();
}

// The font size, in the units of `radius`, at which no numeral of `texts`
// outgrows a face whose inscribed circle has that radius.
function sizeFor(context: CanvasRenderingContext2D, texts: string[], radius: number, tall: number) {
  return Math.min(
    ...texts.map((text) => {
      const ink = inkOf(context, text, false);
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
  const cellPx = shape.ball ? BALL_CELL_PX : CELL_PX;
  const canvas = document.createElement("canvas");
  canvas.width = layout.columns * cellPx;
  canvas.height = layout.columns * cellPx;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2D canvas for the dice numerals");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.textAlign = "center";
  const texts = shape.features.map(({ text }) => text);
  const pen: Pen = { cellPx, context, layout, lined: linedOf(texts) };
  const circles = shape.faces.map((_, index) => inscribed(shape, index, layout));
  // In die units; every numeral of a die is one size, but a ball's 100,
  // which would make the other ninety-nine small.
  const sizeOf = (some: string[]) =>
    sizeFor(
      context,
      some,
      Math.min(...circles.map(({ radius }) => radius)),
      kind === "d4" ? D4_DIGIT_HEIGHT : DIGIT_HEIGHT,
    );
  const height = sizeOf(texts.filter((text) => text.length < 3));
  const longHeight = sizeOf(texts);

  for (const [index, face] of shape.faces.entries()) {
    const cell = layout.cells[index]!;
    const { text } = shape.features[index] ?? { text: "" };
    const size = ((text.length < 3 ? height : longHeight) / cell.span) * cellPx;
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
      at: circles[index]!.at,
      face: index,
      size,
      text,
      up: cell.up,
    });
  }
  return canvas;
}
