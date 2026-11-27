import type { TLDrawShape } from "@tldraw/tlschema";

import { b64Vecs, createShapeId, PageRecordType } from "@tldraw/tlschema";
import { ZERO_INDEX_KEY } from "@tldraw/utils";
import { describe, expect, it } from "vitest";

import { Doc } from "../../src/ops/doc";
import { pageBounds } from "../../src/ops/geometry";

const page = PageRecordType.create({ index: ZERO_INDEX_KEY, name: "Page 1" });

function stroke(points: { x: number; y: number }[], dim: 2 | undefined): TLDrawShape {
  return {
    id: createShapeId(),
    index: ZERO_INDEX_KEY,
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
      segments: [{ ...(dim && { dim }), path: b64Vecs.encodePoints(points, dim), type: "free" }],
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
  // WARNING: Mouse and trackpad strokes carry no pressure, so tldraw stores them with dim 2.
  it.each([
    [2, 3],
    [2, 4],
    [2, 5],
    [undefined, 3],
  ] as const)("measures a stroke with dim %s and %i points", (dim, count) => {
    const points = Array.from({ length: count }, (_, i) => ({ x: i * 10, y: i * 5 }));
    const shape = stroke(points, dim);
    expect(pageBounds(new Doc([page, shape]), shape)).toEqual({
      h: (count - 1) * 5,
      w: (count - 1) * 10,
      x: 100,
      y: 200,
    });
  });

  it("places a one-point stroke at its origin", () => {
    const shape = stroke([{ x: 0, y: 0 }], 2);
    expect(pageBounds(new Doc([page, shape]), shape)).toMatchObject({ x: 100, y: 200 });
  });
});
