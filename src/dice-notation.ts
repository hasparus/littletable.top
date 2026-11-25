import { DIE_SIDES, MAX_DICE } from "./limits";

export const MAX_EXPRESSION_LENGTH = 256;
export const MAX_MODIFIER = 1000;

/** Release point and velocity, each expressed relative to the tray. */
export type DiceLaunch = { vx: number; vz: number; x: number; z: number };

export type Roll = {
  at: number;
  dice: { sides: number; value: number }[];
  expression?: string;
  id: number;
  /** The live throw's release state. It is omitted from history. */
  launch?: DiceLaunch;
  name: string;
  /** The shared animation seed. Existing rolls without a saved seed use null. */
  seed: number | null;
  sub: string;
};

export type RollRequest = { dice: number[]; launch?: DiceLaunch } | { expression: string };

type Rule = { count: number; kind: "dh" | "dl" | "kh" | "kl" };
type Group = { count: number; rule: Rule | null; sides: number };
export type Notation = { groups: Group[]; modifier: number | null };
export type NotationError = "count" | "length" | "modifier" | "rule" | "sides" | "syntax";

export type RollResult = {
  kept: boolean[];
  notation: Notation | null;
  total: number;
};

const GROUP = /^(\d*)[dk](\d+)(?:(kh|kl|dh|dl|k)(\d+))?\s*/iu;
const SIGNED_NUMBER = /^([+−-])\s*(\d+)\s*$/u;
const SIDES: readonly number[] = DIE_SIDES;

export function parseNotation(expression: string): Notation | NotationError {
  if (expression.length > MAX_EXPRESSION_LENGTH) return "length";
  const groups: Group[] = [];
  let dice = 0;
  let remaining = expression.trim();
  for (;;) {
    const group = GROUP.exec(remaining);
    if (group === null) return "syntax";
    const [match, countText, sidesText, ruleText, ruleCountText] = group;
    const count = countText === "" ? 1 : Number(countText);
    const sides = Number(sidesText);
    if (count === 0 || dice + count > MAX_DICE) return "count";
    if (!SIDES.includes(sides)) return "sides";

    const kind = ruleText?.toLowerCase();
    const ruleCount = Number(ruleCountText);
    if (kind !== undefined && (ruleCount === 0 || ruleCount > count)) return "rule";
    const rule =
      kind === undefined
        ? null
        : { count: ruleCount, kind: kind === "k" ? "kh" : (kind as Rule["kind"]) };
    groups.push({ count, rule, sides });
    dice += count;

    remaining = remaining.slice(match.length);
    if (remaining === "") return { groups, modifier: null };
    const bonus = SIGNED_NUMBER.exec(remaining);
    if (bonus !== null) {
      const modifier = Number(bonus[2]) * (bonus[1] === "+" ? 1 : -1);
      return Math.abs(modifier) <= MAX_MODIFIER ? { groups, modifier } : "modifier";
    }
    if (!remaining.startsWith("+")) return "syntax";
    remaining = remaining.slice(1).trimStart();
  }
}

export function notationPool(notation: Notation): number[] {
  return notation.groups.flatMap(({ count, sides }) => Array.from({ length: count }, () => sides));
}

export function rollResult(roll: {
  dice: readonly { value: number }[];
  expression?: string;
}): RollResult {
  const parsed = roll.expression === undefined ? null : parseNotation(roll.expression);
  const notation = typeof parsed === "string" ? null : parsed;
  const kept = roll.dice.map(() => true);
  let offset = 0;
  for (const { count, rule } of notation?.groups ?? []) {
    if (rule !== null) {
      const drop = rule.kind === "dh" || rule.kind === "dl";
      const high = rule.kind === "kh" || rule.kind === "dl";
      const keepCount = drop ? count - rule.count : rule.count;
      // NOTE: ties keep earlier dice, including under equivalent keep and drop rules.
      const ranked = roll.dice
        .slice(offset, offset + count)
        .map(({ value }, index) => ({ index: offset + index, value }))
        .sort((a, b) => (high ? b.value - a.value : a.value - b.value) || a.index - b.index);
      for (const { index } of ranked.slice(keepCount)) kept[index] = false;
    }
    offset += count;
  }
  const total = roll.dice.reduce(
    (sum, { value }, index) => sum + (kept[index] ? value : 0),
    notation?.modifier ?? 0,
  );
  return { kept, notation, total };
}
