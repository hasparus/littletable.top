import { describe, expect, it } from "vitest";

import {
  MAX_EXPRESSION_LENGTH,
  notationPool,
  parseNotation,
  rollResult,
} from "../src/dice-notation";

describe("dice notation", () => {
  it.each([
    ["3d6kh2", [6, 6, 6], "kh", 2, null],
    ["2d20kl1", [20, 20], "kl", 1, null],
    ["4d6dl1", [6, 6, 6, 6], "dl", 1, null],
    ["4d6dh1", [6, 6, 6, 6], "dh", 1, null],
    ["2d6 + d20 + 3", [6, 6, 20], null, null, 3],
    ["3k6kh2", [6, 6, 6], "kh", 2, null],
    ["2k6+3", [6, 6], null, null, 3],
    ["  3K6K2 + D20 - 1000 ", [6, 6, 6, 20], "kh", 2, -1000],
    ["d100 + 1000", [100], null, null, 1000],
  ])("reads %s", (expression, pool, kind, count, modifier) => {
    const notation = parseNotation(expression);
    if (typeof notation === "string") throw new Error(notation);
    expect(notationPool(notation)).toEqual(pool);
    expect(notation.groups[0]!.rule).toEqual(kind === null ? null : { count, kind });
    expect(notation.modifier).toBe(modifier);
  });

  it.each([
    ["3d6kh4", "rule"],
    ["3d6dh4", "rule"],
    ["3d6kh0", "rule"],
    ["0d6", "count"],
    ["d7", "sides"],
    ["20d6+d20", "count"],
    ["d6+1001", "modifier"],
    ["d6-99999999999999999999", "modifier"],
    ["d6 ".padEnd(MAX_EXPRESSION_LENGTH + 1), "length"],
    ["d6 adv", "syntax"],
    ["2d6 +", "syntax"],
    ["d6 - d8", "syntax"],
    ["3", "syntax"],
  ])("refuses %s", (expression, error) => {
    expect(parseNotation(expression)).toBe(error);
  });
});

describe("dice roll results", () => {
  const dice = [2, 6, 2, 1, 8, 4].map((value) => ({ value }));

  it("counts all dice in rolls without notation", () => {
    expect(rollResult({ dice })).toEqual({
      kept: [true, true, true, true, true, true],
      notation: null,
      total: 23,
    });
  });

  it.each(["4d6kh2 + 2d8kl1 - 3", "4d6dl2 + 2d8dh1 - 3"])(
    "keeps the same dice for %s, keeping the earlier die on ties",
    (expression) => {
      const { kept, total } = rollResult({ dice, expression });
      expect(kept).toEqual([true, true, false, false, false, true]);
      expect(total).toBe(9);
    },
  );

  it("can drop a whole group and return a negative total", () => {
    const { kept, total } = rollResult({ dice: [{ value: 6 }], expression: "d6dl1 - 2" });
    expect(kept).toEqual([false]);
    expect(total).toBe(-2);
  });
});
