import type { Check, Expression, Formula, Rule } from "./dice-expression";

import { InvalidRoll, MAX_DRAWS, MAX_SIDES } from "./dice-expression";
import { MAX_DICE } from "./limits";

export type DiceMark = "success" | "failure" | "critical" | "botch" | "match";
export type Die = { sides: number; value: number; fate?: true; mark?: DiceMark };
export type Outcome = { total: number; kept: boolean[] };

type Entry = { value: number; dice: number[]; score?: number };
type Evaluation = { total: number; entries: Entry[] | null; dice: number[] };
type Source = {
  sides: number;
  min: number;
  max: number;
  value: (face: number) => number;
  fate?: true;
};
type Draw = (source: Source) => Entry;

const flat = (entries: Entry[]) => entries.flatMap(({ dice }) => dice);
const constant: (total: number, dice?: number[]) => Evaluation = (total, dice = []) => ({
  total,
  entries: null,
  dice,
});
const scoreOf = ({ score, value }: Entry) => score ?? value;

function score(entries: Entry[]) {
  return {
    total: entries.reduce((sum, entry) => sum + scoreOf(entry), 0),
    entries,
    dice: flat(entries),
  } satisfies Evaluation;
}

function matches({ op, target }: Check, value: number) {
  switch (op) {
    case "=":
      return value === target;
    case "<>":
      return value !== target;
    case "<":
      return value < target;
    case "<=":
      return value <= target;
    case ">":
      return value > target;
    case ">=":
      return value >= target;
    case "any":
      return true;
    case "even":
      return value % 2 === 0;
    case "odd":
      return value % 2 !== 0;
  }
}

function arithmetic(op: Extract<Expression, { kind: "math" }>["op"], a: number, b: number) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    case "**":
      return a ** b;
  }
}

function finite(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    throw new InvalidRoll("math");
  return value;
}

function withValue(entry: Entry, value: number) {
  return { ...entry, value: finite(value) };
}

type Reroll = Extract<Rule, { kind: "reroll" | "unique" }>;
type Explosion = Extract<Rule, { kind: "explode" }>;
type Clamp = Extract<Rule, { kind: "minimum" | "maximum" }>;

function withClamp(entry: Entry, rule: Clamp) {
  const value =
    rule.kind === "minimum"
      ? Math.max(entry.value, rule.target)
      : Math.min(entry.value, rule.target);
  return withValue(entry, value);
}

function presentationOnly({ kind }: Rule) {
  return kind === "sort" || kind === "critical" || kind === "botch" || kind === "matches";
}

function reroll(entry: Entry, rules: Reroll[], draw: () => Entry) {
  const used = new Set<Reroll>();
  for (;;) {
    const rule = rules.find(
      (candidate) => !used.has(candidate) && matches(candidate.check, entry.value),
    );
    if (rule === undefined) return entry;
    if (rule.once) used.add(rule);
    entry = draw();
  }
}

function explode(entries: Entry[], rule: Explosion, source: Source, draw: () => Entry) {
  let added = false;
  return entries.flatMap((entry) => {
    const chain = [entry];
    const trigger = rule.check ?? { op: "=", target: source.max };
    let raw = entry.value;
    while ((!added || !rule.firstOnly) && chain.length <= rule.cap && matches(trigger, raw)) {
      const extra = draw();
      raw = extra.value;
      chain.push(rule.penetrate ? withValue(extra, raw - 1) : extra);
      added = true;
    }
    return rule.compound ? [{ ...entry, dice: flat(chain), value: score(chain).total }] : chain;
  });
}

const ROLL20_ORDER: Record<Rule["kind"], number> = {
  bonus: 0,
  middle: 4,
  minimum: 0,
  maximum: 0,
  reroll: 1,
  unique: 2,
  explode: 3,
  keep: 4,
  drop: 4,
  exclude: 4,
  select: 4,
  score: 5,
  deduct: 6,
  subtract: 6,
  margin: 6,
  double: 6,
  critical: 7,
  botch: 7,
  matches: 7,
  tally: 7,
  sort: 8,
};

class Evaluator {
  readonly dice: Die[] = [];
  private baseDice = 0;
  private order: number[] = [];

  constructor(
    private dialect: Formula["dialect"],
    private random: (sides: number) => number,
  ) {}

  private draw: Draw = ({ sides, value, fate }) => {
    if (this.dice.length >= MAX_DRAWS) throw new InvalidRoll("limit");
    const face = value(this.random(sides));
    const die: Die = { sides, value: face };
    if (fate) die.fate = fate;
    const index = this.dice.push(die) - 1;
    this.order.push(index);
    return { value: face, dice: [index] };
  };

  result(root: Expression) {
    const evaluated = this.evaluate(root);
    const active = new Set(evaluated.dice);
    return {
      dice: this.order.map((index) => this.dice[index]!),
      outcome: {
        kept: this.order.map((index) => active.has(index)),
        total: finite(evaluated.total),
      },
    };
  }

  private evaluate: (node: Expression) => Evaluation = (node) => {
    switch (node.kind) {
      case "number":
        return constant(finite(node.value));
      case "inline": {
        const result = this.evaluate(node.arg);
        return constant(result.total, result.dice);
      }
      case "function": {
        const result = this.evaluate(node.arg);
        return constant(finite(Math[node.name](result.total)), result.dice);
      }
      case "math": {
        const left = this.evaluate(node.left);
        const right = this.evaluate(node.right);
        const total = finite(arithmetic(node.op, left.total, right.total));
        const dice = [...left.dice, ...right.dice];
        if (node.op === "+" && left.entries !== null && right.entries !== null) {
          return { total, dice, entries: [...left.entries, ...right.entries] };
        }
        const adjust = (entries: Entry[], op: (value: number) => number, other: number[]) =>
          entries.map((entry) => ({
            ...entry,
            dice: [...entry.dice, ...other],
            value: finite(op(scoreOf(entry))),
            score: undefined,
          }));
        const entries =
          left.entries !== null && right.entries === null
            ? adjust(left.entries, (value) => arithmetic(node.op, value, right.total), right.dice)
            : right.entries !== null && left.entries === null
              ? adjust(right.entries, (value) => arithmetic(node.op, left.total, value), left.dice)
              : null;
        return { total, dice, entries };
      }
      case "compare": {
        const left = this.evaluate(node.left);
        const right = this.evaluate(node.right);
        return constant(Number(matches({ op: node.op, target: right.total }, left.total)), [
          ...left.dice,
          ...right.dice,
        ]);
      }
      case "group": {
        const parts = node.entries.map((entry) => this.evaluate(entry));
        const entries = node.totals
          ? parts.map(({ total, dice }) => ({ value: total, dice }))
          : (parts[0]!.entries ?? [{ value: parts[0]!.total, dice: parts[0]!.dice }]);
        if (!node.totals && node.rules.every(presentationOnly)) {
          if (node.rules.length > 0) this.modify(entries, node.rules, undefined, parts[0]!.total);
          return parts[0]!;
        }
        return this.modify(entries, node.rules);
      }
      case "dice": {
        const count = this.evaluate(node.count);
        let bonus = 0;
        for (const rule of node.rules) if (rule.kind === "bonus") bonus += rule.count;
        const amount = Math.round(count.total);
        const starting = amount + Math.abs(bonus);
        this.baseDice += starting;
        if (amount < 0 || this.baseDice > MAX_DICE) throw new InvalidRoll("count");
        if (amount === 0) return { total: 0, entries: [], dice: count.dice };
        const sides =
          node.faces === "fate" || node.faces === "fudge" || node.faces === "tens"
            ? null
            : this.evaluate(node.faces);
        const source = this.source(node.faces, sides?.total);
        const initial = Array.from({ length: starting }, () => this.draw(source));
        const selected =
          bonus === 0
            ? initial
            : new Set(
                initial
                  .toSorted((a, b) => (bonus > 0 ? b.value - a.value : a.value - b.value))
                  .slice(0, amount),
              );
        const result = this.modify(
          Array.isArray(selected) ? selected : initial.filter((entry) => selected.has(entry)),
          node.rules,
          source,
        );
        return { ...result, dice: [...count.dice, ...(sides?.dice ?? []), ...result.dice] };
      }
    }
  };

  private source: (
    faces: Extract<Expression, { kind: "dice" }>["faces"],
    total?: number,
  ) => Source = (faces, total) => {
    switch (faces) {
      case "fate":
        return { sides: 3, fate: true, min: -1, max: 1, value: (face) => face - 2 };
      case "fudge":
        return {
          sides: 6,
          fate: true,
          min: -1,
          max: 1,
          value: (face) => (face === 1 ? -1 : Number(face === 6)),
        };
      case "tens":
        return { sides: 10, min: 0, max: 90, value: (face) => (face - 1) * 10 };
      default: {
        if (total === undefined || !Number.isInteger(total) || total < 1 || total > MAX_SIDES)
          throw new InvalidRoll("sides");
        return { sides: total, min: 1, max: total, value: (face) => face };
      }
    }
  };

  private mark(entry: Entry, mark: DiceMark) {
    for (const index of entry.dice) this.dice[index]!.mark = mark;
  }

  private sort(entries: Entry[], descending: boolean) {
    const ids = new Set(
      flat(entries.toSorted((a, b) => (descending ? b.value - a.value : a.value - b.value))),
    );
    const next = [...ids];
    let at = 0;
    this.order = this.order.map((index) => (ids.has(index) ? next[at++]! : index));
  }

  private modify(entries: Entry[], rules: Rule[], source?: Source, displayedTotal?: number) {
    const foundry = this.dialect === "foundry";
    const ordered = foundry
      ? rules
      : rules.toSorted((a, b) => ROLL20_ORDER[a.kind] - ROLL20_ORDER[b.kind]);
    const repeats = foundry ? [] : rules.filter((rule): rule is Reroll => rule.kind === "reroll");
    const clamps = foundry
      ? []
      : ordered.filter((rule): rule is Clamp => rule.kind === "minimum" || rule.kind === "maximum");
    const draw = () => {
      if (source === undefined) throw new InvalidRoll("rule");
      let entry = this.draw(source);
      for (const rule of clamps) entry = withClamp(entry, rule);
      return entry;
    };
    let margin = 0;
    for (const rule of ordered) {
      switch (rule.kind) {
        case "bonus":
          break;
        case "middle": {
          const start = Math.max(0, Math.floor((entries.length - rule.count) / 2));
          const kept = new Set(
            entries.toSorted((a, b) => a.value - b.value).slice(start, start + rule.count),
          );
          entries = entries.filter((entry) => kept.has(entry));
          break;
        }
        case "reroll":
          if (foundry) entries = entries.map((entry) => reroll(entry, [rule], draw));
          else if (rule === repeats[0])
            entries = entries.map((entry) => reroll(entry, repeats, draw));
          break;
        case "unique": {
          const seen = new Set<number>();
          entries = entries.map((entry) => {
            if (seen.has(entry.value) && matches(rule.check, entry.value)) {
              do entry = draw();
              while (!rule.once && seen.has(entry.value) && matches(rule.check, entry.value));
            }
            seen.add(entry.value);
            return entry;
          });
          break;
        }
        case "explode":
          if (source === undefined) throw new InvalidRoll("rule");
          entries = explode(entries, rule, source, () => reroll(draw(), repeats, draw));
          break;
        case "keep":
        case "drop": {
          if (rule.count > entries.length && foundry) break;
          if (rule.count > entries.length && rules.every((modifier) => modifier.kind !== "explode"))
            throw new InvalidRoll("rule");
          const drop = rule.kind === "drop";
          const high = rule.high !== drop;
          const ranked = entries.toSorted((a, b) => (high ? b.value - a.value : a.value - b.value));
          const kept = new Set(
            ranked.slice(0, drop ? Math.max(0, entries.length - rule.count) : rule.count),
          );
          entries = entries.filter((entry) => kept.has(entry));
          break;
        }
        case "select":
        case "exclude":
          entries = entries.filter(
            (entry) => matches(rule.check, entry.value) === (rule.kind === "select"),
          );
          break;
        case "minimum":
        case "maximum":
          entries = entries.map((entry) => withClamp(entry, rule));
          break;
        case "margin":
          margin += rule.target;
          break;
        case "score":
          entries = entries.map((entry) => {
            const hit = matches(rule.check, entry.value);
            if (hit) this.mark(entry, rule.failure ? "failure" : "success");
            return { ...entry, score: Number(hit) };
          });
          break;
        case "deduct":
        case "subtract":
          entries = entries.map((entry) => {
            if (!matches(rule.check, entry.value)) return entry;
            this.mark(entry, "failure");
            return {
              ...entry,
              score: rule.kind === "subtract" ? -entry.value : scoreOf(entry) - 1,
            };
          });
          break;
        case "critical":
        case "botch": {
          const defaultTarget = rule.kind === "critical" ? source?.max : source?.min;
          const target = rule.check ?? { op: "=", target: defaultTarget ?? 0 };
          for (const entry of entries)
            if (matches(target, entry.value)) this.mark(entry, rule.kind);
          break;
        }
        case "matches":
        case "tally":
        case "double": {
          if (rule.kind === "double") {
            entries = entries.map((entry) =>
              matches(rule.check, entry.value) ? { ...entry, score: scoreOf(entry) * 2 } : entry,
            );
            break;
          }
          const counts = new Map<number, number>();
          for (const { value } of entries) counts.set(value, (counts.get(value) ?? 0) + 1);
          const qualifying = new Set<number>();
          for (const [value, count] of counts) {
            if (count >= rule.count && matches(rule.check, value)) qualifying.add(value);
          }
          const seen = new Set<number>();
          entries = entries.map((entry) => {
            const hit = qualifying.has(entry.value);
            if (hit) this.mark(entry, "match");
            if (rule.kind !== "tally") return entry;
            const scored = hit && !seen.has(entry.value);
            seen.add(entry.value);
            return { ...entry, score: Number(scored) };
          });
          break;
        }
        case "sort":
          this.sort(entries, rule.descending);
          break;
      }
    }
    const result = score(entries);
    return { ...result, total: finite(displayedTotal ?? result.total - margin) };
  }
}

export function evaluateExpression(formula: Formula, draw: (sides: number) => number) {
  return new Evaluator(formula.dialect, draw).result(formula.root);
}
