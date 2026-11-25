/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import docs from "../client/docs/index.html?raw";
import { evaluateExpression } from "../src/dice-evaluation";
import { InvalidRoll, MAX_DRAWS, parseExpression } from "../src/dice-expression";

function evaluate(expression: string, values: number[]) {
  const formula = parseExpression(expression);
  if ("error" in formula) throw new InvalidRoll(formula.error);
  let index = 0;
  return evaluateExpression(formula, (sides) => {
    const face = values[index++];
    if (face === undefined || face < 1 || face > sides)
      throw new Error("Missing die for " + expression);
    return face;
  });
}

describe("dice expressions", () => {
  it.each([
    ["2d20kl1", [16, 4], 4],
    ["4d6>5f1", [5, 6, 1, 3], 1],
    ["4d6count5+", [5, 6, 1, 3], 2],
    ["4d6 t5", [5, 6, 1, 3], 2],
    ["4d6c[>=5]", [5, 6, 1, 3], 2],
    ["rpg:4d6>5", [5, 6, 1, 3], 1],
    ["avrae:4d6>5", [5, 6, 1, 3], 1],
    ["d6r1r2", [1, 2, 5], 5],
    ["d6ro<2", [2, 2], 2],
    ["foundry:d6r2", [2, 2], 2],
    ["maiden:d6r2", [1, 3], 3],
    ["rolisteam:d6R[<3]", [1, 2, 3], 3],
    ["d6!p", [6, 6, 2], 12],
    ["d6!!>5", [5, 6, 1], 12],
    ["d6x2=6", [6, 6, 6], 18],
    ["d6xo6", [6, 6], 12],
    ["maiden:d6e6", [6, 6], 12],
    ["avrae:d6e6", [6, 6, 2], 14],
    ["rolisteam:2d6K1", [6, 5, 2], 8],
    ["{d6!!,d8}kh1", [6, 2, 7], 8],
    ["{d6+d8}kh1", [6, 7], 7],
    ["{3d20+5}>21", [16, 15, 20], 2],
    ["(1+2)d(4+2)", [6, 1, 2], 9],
    ["2 ** 3 ** 2 + floor(3.75)", [], 515],
    ["maiden:1d6 + 2 * 3", [3], 15],
    ["dF + dF.1", [1, 6], 0],
    ["d%", [100], 100],
    ["avrae:d%", [10], 90],
    ["0d0 + 7", [], 7],
    ["4d6cs=6", [6, 3, 2, 1], 12],
    ["foundry:4d6cs=6", [6, 3, 2, 1], 1],
    ["foundry:d6cs=6x6", [6, 2], 3],
    ["foundry:d6x6cs=6", [6, 2], 1],
    ["2d6k1", [3, 4], 4],
    ["avrae:2d6k3", [3, 4], 3],
    ["4d6mt", [1, 1, 2, 2], 2],
    ["2d6ie6adv1", [6, 4, 1, 5], 15],
  ] satisfies [string, number[], number][])("evaluates %s", (expression, values, expected) => {
    expect(evaluate(expression, values).outcome.total).toBe(expected);
  });

  it("persists the visible faces and the kept mask in the same order", () => {
    const { dice, outcome } = evaluate("3d6ro1kh2sdcs=6", [1, 6, 3, 4]);
    expect(dice.map(({ value }) => value)).toEqual([1, 6, 3, 4]);
    expect(dice[1]?.mark).toBe("critical");
    expect(outcome).toEqual({ kept: [false, true, false, true], total: 10 });
    expect(evaluate("3d6sd", [1, 6, 3]).dice.map(({ value }) => value)).toEqual([6, 3, 1]);
  });

  it("rejects stalled rolls within a fixed number of draws", () => {
    const formula = parseExpression("d1!");
    if ("error" in formula) throw new Error(formula.error);
    let draws = 0;
    expect(() =>
      evaluateExpression(formula, () => {
        draws++;
        return 1;
      }),
    ).toThrow("limit");
    expect(draws).toBe(MAX_DRAWS);
    expect(() => evaluate("0 / 0", [])).toThrow("math");
    expect(parseExpression("21d6")).toEqual({ error: "count" });
    expect(parseExpression("d1000001")).toEqual({ error: "sides" });
  });

  const examples = [...docs.matchAll(/<code data-roll>([^<]+)<\/code>/gu)].map(([, expression]) =>
    expression!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  );
  it.each(examples)("executes the documented example %s", (expression) => {
    const formula = parseExpression(expression);
    if ("error" in formula) throw new InvalidRoll(formula.error);
    let state = 739;
    const rolled = evaluateExpression(formula, (sides) => {
      state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
      return (state % sides) + 1;
    });
    expect(Number.isFinite(rolled.outcome.total)).toBe(true);
  });
});
