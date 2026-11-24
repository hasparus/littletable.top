import type { Roll } from "./bootstrap";

import { type Notation, rollResult } from "../../src/dice-notation";
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

// "2d6 + d20": the pool grouped by die, small to large.
export function poolLabel(copy: Copy, sides: number[]): string {
  const counts = new Map<number, number>();
  for (const side of sides.toSorted((a, b) => a - b)) counts.set(side, (counts.get(side) ?? 0) + 1);
  return [...counts]
    .map(([side, count]) => `${count > 1 ? count : ""}${dieLabel(copy, side)}`)
    .join(" + ");
}

export function rollSentence(copy: Copy, roll: Roll): string {
  const result = rollResult(roll);
  const values = roll.dice.map(({ value }) => value).join(", ");
  const pool =
    result.notation === null
      ? poolLabel(
          copy,
          roll.dice.map(({ sides }) => sides),
        )
      : notationLabel(copy, result.notation);
  const sentences = [`${fill(copy.rolledBy, { name: roll.name })} ${pool}: ${values}`];
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
