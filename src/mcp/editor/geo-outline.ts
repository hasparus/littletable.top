import type { TLGeoShape } from "@tldraw/tlschema";

import type { Vec } from "../../ops/geometry";

// Whether a point (in the shape's own space) is inside a geo shape's
// outline. tldraw asks its path geometry; here each geo is the polygon or
// ellipse its path follows. Hearts, clouds and stars are taken as the
// ellipse in their box, which errs towards "does not fit".

const polygon = (points: Vec[], { x, y }: Vec): boolean => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

const around = (w: number, h: number, sides: number): Vec[] =>
  Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
    return { x: w / 2 + (w / 2) * Math.cos(angle), y: h / 2 + (h / 2) * Math.sin(angle) };
  });

export function geoHitTest(shape: TLGeoShape, point: Vec, margin: number, hitInside: boolean) {
  if (!hitInside) return false;
  const { geo, growY, h: height, w } = shape.props;
  const h = height + growY;
  const { x, y } = point;
  const inBox = x >= -margin && x <= w + margin && y >= -margin && y <= h + margin;
  switch (geo) {
    case "cloud":
    case "ellipse":
    case "heart":
    case "oval":
    case "star": {
      const dx = (x - w / 2) / (w / 2 + margin);
      const dy = (y - h / 2) / (h / 2 + margin);
      return dx * dx + dy * dy <= 1;
    }
    case "diamond":
      return polygon(around(w, h, 4), point);
    case "hexagon":
      return polygon(around(w, h, 6), point);
    case "octagon":
      return polygon(around(w, h, 8), point);
    case "pentagon":
      return polygon(around(w, h, 5), point);
    case "triangle":
      return polygon(
        [
          { x: w / 2, y: 0 },
          { x: w, y: h },
          { x: 0, y: h },
        ],
        point,
      );
    default:
      return inBox;
  }
}
