import { expect, it } from "vitest";

import { droppedEdge } from "../client/src/paper-landing";

it("drops from the height reached at release, rebounding before resting on the table", () => {
  for (const lift of [0.13, 1]) {
    const heights = droppedEdge(lift);
    expect(heights[0]).toBe(lift);
    expect(heights[1]).toBeLessThan(lift);
    expect(Math.min(...heights)).toBe(0);
    expect(heights.at(-1)).toBe(0);
    expect(heights.some((height, index) => index > 0 && height > heights[index - 1]!)).toBe(true);
  }
  expect(droppedEdge(0.13).length).toBeLessThan(droppedEdge(1).length);
});
