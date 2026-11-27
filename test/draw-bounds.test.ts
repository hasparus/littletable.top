import type { TLDrawShape, TLPage, TLRecord } from "@tldraw/tlschema";

import { b64Vecs, createShapeId, PageRecordType } from "@tldraw/tlschema";
import { describe, expect, it } from "vitest";

import { Doc } from "../src/ops/doc";
import { pageBounds } from "../src/ops/geometry";

const page: TLPage = PageRecordType.create({ index: "a1" as TLPage["index"], name: "Page 1" });

function stroke(points: { x: number; y: number }[], dim: 2 | 3): TLDrawShape {
  return {
    id: createShapeId(),
    index: "a1" as TLDrawShape["index"],
    isLocked: false,
    meta: {},
    opacity: 1,
    parentId: page.id,
    props: {
      color: "black",
      dash: "draw",
      fill: "none",
      isClosed: false,
      isComplete: true,
      isPen: false,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      segments: [
        dim === 2
          ? { dim: 2, path: b64Vecs.encodePoints(points, 2), type: "free" }
          : { path: b64Vecs.encodePoints(points), type: "free" },
      ],
      size: "m",
    },
    rotation: 0,
    type: "draw",
    typeName: "shape",
    x: 100,
    y: 200,
  };
}

describe("draw stroke bounds", () => {
  // NOTE: Mouse and trackpad strokes carry no pressure, so tldraw stores them as 2D points.
  it.each([
    [2, 1],
    [2, 3],
    [2, 4],
    [3, 3],
  ] as const)("measures a %iD stroke of %i points", (dim, count) => {
    const points = Array.from({ length: count }, (_, i) => ({ x: i * 10, y: i * 5 }));
    const shape = stroke(points, dim);
    const doc = new Doc([page, shape] as TLRecord[]);
    expect(pageBounds(doc, shape)).toEqual({
      h: (count - 1) * 5,
      w: (count - 1) * 10,
      x: 100,
      y: 200,
    });
  });
});
