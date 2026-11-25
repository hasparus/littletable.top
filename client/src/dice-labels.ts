import type { Roll } from "./bootstrap";

import { type ExpressionError, MAX_SIDES, MAX_DRAWS } from "../../src/dice-expression";
import {
  MAX_EXPRESSION_LENGTH,
  MAX_MODIFIER,
  type Notation,
  rollResult,
} from "../../src/dice-notation";
import { MAX_DICE } from "../../src/limits";
import { type Copy, dieLabel, fill } from "./copy";

export const modifierLabel = (modifier: number) =>
  `${modifier < 0 ? "−" : "+"} ${Math.abs(modifier)}`;

export function notationLabel(copy: Copy, { groups, modifier }: Notation): string {
  const pool = groups
    .map(
      ({ count, rule, sides }) =>
        `${count > 1 ? count : ""}${dieLabel(copy, sides)}${rule === null ? "" : `${rule.kind}${rule.count}`}`,
    )
    .join(" + ");
  return modifier === null ? pool : `${pool} ${modifierLabel(modifier)}`;
}

export function poolLabel(copy: Copy, sides: number[]): string {
  const counts = new Map<number, number>();
  for (const side of sides.toSorted((a, b) => a - b)) counts.set(side, (counts.get(side) ?? 0) + 1);
  return [...counts]
    .map(([side, count]) => `${count > 1 ? count : ""}${dieLabel(copy, side)}`)
    .join(" + ");
}

export function notationMessage(copy: Copy, error: ExpressionError, example = "2d20kl1") {
  switch (error) {
    case "count":
      return fill(copy.notationCount, { max: MAX_DICE });
    case "length":
      return fill(copy.notationLength, { max: MAX_EXPRESSION_LENGTH });
    case "modifier":
      return fill(copy.notationModifier, { max: MAX_MODIFIER });
    case "rule":
      return copy.notationRule;
    case "sides":
      return fill(copy.notationSides, { max: MAX_SIDES });
    case "limit":
      return fill(copy.notationDrawLimit, { max: MAX_DRAWS });
    case "math":
      return copy.notationMath;
    case "syntax":
      return fill(copy.notationSyntax, { example });
  }
}

export function rollLabel(copy: Copy, roll: Roll, notation: Notation | null) {
  if (notation !== null) return notationLabel(copy, notation);
  return (
    roll.expression ??
    poolLabel(
      copy,
      roll.dice.map(({ sides }) => sides),
    )
  );
}

export function rollSentence(copy: Copy, roll: Roll) {
  const result = rollResult(roll);
  const values = roll.dice.map(({ value }) => value).join(", ");
  const label = rollLabel(copy, roll, result.notation);
  const sentences = [
    fill(copy.rolledBy, { name: roll.name }) + (values ? " " + label + ": " + values : " " + label),
  ];
  if (result.notation !== null) {
    const kept = roll.dice.filter((_, index) => result.kept[index]).map(({ value }) => value);
    sentences.push(
      kept.length === 0 ? copy.noDiceKept : fill(copy.keptDice, { dice: kept.join(", ") }),
    );
    if (result.notation.modifier !== null) {
      sentences.push(
        fill(copy.rollModifier, { modifier: modifierLabel(result.notation.modifier) }),
      );
    }
  }
  sentences.push(`${copy.total}: ${result.total}`);
  return sentences.join(". ");
}
