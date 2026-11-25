import type { Notation, NotationError } from "./dice-notation";

import { legacyNotation, MAX_EXPRESSION_LENGTH } from "./dice-notation";
import { MAX_DICE } from "./limits";

export const MAX_SIDES = 1_000_000;
export const MAX_DRAWS = 100;

const DIALECTS = ["roll20", "foundry", "avrae", "rpg", "maiden", "rolisteam"] as const;
type Dialect = (typeof DIALECTS)[number];

export type Check = {
  op: "=" | "<" | "<=" | ">" | ">=" | "<>" | "any" | "even" | "odd";
  target: number;
};

export type Rule =
  | { kind: "keep" | "drop"; high: boolean; count: number }
  | { kind: "exclude" | "select"; check: Check }
  | { kind: "bonus"; count: number }
  | { kind: "middle"; count: number }
  | { kind: "reroll" | "unique"; once: boolean; check: Check }
  | {
      kind: "explode";
      cap: number;
      compound: boolean;
      penetrate: boolean;
      firstOnly: boolean;
      check: Check | null;
    }
  | { kind: "score" | "deduct" | "subtract"; check: Check; failure: boolean }
  | { kind: "critical" | "botch"; check: Check | null }
  | { kind: "matches" | "tally" | "double"; check: Check; count: number }
  | { kind: "minimum" | "maximum" | "margin"; target: number }
  | { kind: "sort"; descending: boolean };

type Arithmetic = "+" | "-" | "*" | "/" | "%" | "**";
type MathFunction = "abs" | "floor" | "ceil" | "round";
export type Expression =
  | { kind: "number"; value: number }
  | { kind: "math"; op: Arithmetic; left: Expression; right: Expression }
  | { kind: "compare"; op: Check["op"]; left: Expression; right: Expression }
  | { kind: "function"; name: MathFunction; arg: Expression }
  | { kind: "inline"; arg: Expression }
  | {
      kind: "dice";
      count: Expression;
      faces: Expression | "fate" | "fudge" | "tens";
      rules: Rule[];
    }
  | { kind: "group"; entries: Expression[]; totals: boolean; rules: Rule[] };

export type Formula = { dialect: Dialect; root: Expression; legacy: Notation | null };
export type ExpressionError = NotationError | "math" | "limit";

export const EXPRESSION_ERRORS = [
  "count",
  "length",
  "modifier",
  "rule",
  "sides",
  "syntax",
  "math",
  "limit",
] as const satisfies readonly ExpressionError[];

const number = (value: number) => ({ kind: "number", value }) satisfies Expression;
const check = (op: Check["op"], target = 0) => ({ op, target });
const ARITHMETIC: Arithmetic[] = ["+", "-", "*", "/", "%", "**"];
const MATH_FUNCTIONS: MathFunction[] = ["abs", "floor", "ceil", "round"];

const comparisonOperator: (symbol?: string, inclusive?: boolean) => Check["op"] = (
  symbol,
  inclusive,
) => {
  switch (symbol) {
    case "!=":
    case "<>":
      return "<>";
    case "<=":
      return "<=";
    case ">=":
      return ">=";
    case "<":
      return inclusive ? "<=" : "<";
    case ">":
      return inclusive ? ">=" : ">";
    default:
      return "=";
  }
};

export class InvalidRoll extends Error {
  constructor(readonly reason: ExpressionError) {
    super(reason);
  }
}

class Parser {
  private rest: string;
  private baseDice = 0;

  constructor(
    text: string,
    private dialect: Dialect,
  ) {
    this.rest = text;
  }

  private take(pattern: RegExp, spaced = true) {
    const text = spaced ? this.rest.trimStart() : this.rest;
    const matched = pattern.exec(text)?.[0];
    if (matched !== undefined) this.rest = text.slice(matched.length);
    return matched;
  }

  private require(pattern: RegExp) {
    if (this.take(pattern) === undefined) throw new InvalidRoll("syntax");
  }

  read() {
    const root = this.comparison();
    const rest = this.rest.trim();
    const labelled =
      /^\s+\p{L}/u.test(this.rest) ||
      (this.dialect === "maiden" && /^\s+!/u.test(this.rest)) ||
      (this.dialect === "rolisteam" && rest.startsWith("#"));
    if (rest !== "" && !labelled) throw new InvalidRoll("syntax");
    return root;
  }

  private comparison() {
    const left: Expression = this.arithmetic(1);
    if (this.dialect !== "avrae") return left;
    const op = this.take(/^(?:<=|>=|==|!=|<|>)/u);
    if (op === undefined) return left;
    return {
      kind: "compare",
      left,
      op: comparisonOperator(op),
      right: this.arithmetic(1),
    } satisfies Expression;
  }

  private arithmetic: (min: number) => Expression = (min) => {
    let left: Expression = this.unary();
    for (;;) {
      const token = /^(?:\*\*|[+−*/%-])/u.exec(this.rest.trimStart())?.[0];
      const op = ARITHMETIC.find((operator) => operator === (token === "−" ? "-" : token));
      if (op === undefined) return left;
      const precedence =
        op === "**" ? 3 : this.dialect === "maiden" || op === "+" || op === "-" ? 1 : 2;
      if (precedence < min) return left;
      this.rest = this.rest.trimStart().slice(op.length);
      const right = this.arithmetic(op === "**" ? precedence : precedence + 1);
      left = { kind: "math", left, op, right };
    }
  };

  private unary() {
    this.take(/^\++/u);
    if (this.take(/^[-−]/u) !== undefined) {
      return {
        kind: "math",
        left: number(0),
        op: "-",
        right: this.arithmetic(3),
      } satisfies Expression;
    }
    const atom: Expression = this.atom();
    this.take(/^\[(?!\[)[^\]\r\n]*\]/u);
    return atom;
  }

  private atom() {
    if (this.take(/^\[\[/u) !== undefined) {
      const arg = this.comparison();
      this.require(/^\]\]/u);
      return { kind: "inline", arg } satisfies Expression;
    }
    const func = this.take(/^(?:abs|floor|ceil|round)(?=\s*\()/iu);
    const name = MATH_FUNCTIONS.find((value) => value === func?.toLowerCase());
    if (name !== undefined) {
      this.require(/^\(/u);
      const arg = this.comparison();
      this.require(/^\)/u);
      return { kind: "function", name, arg } satisfies Expression;
    }
    if (this.take(/^\{/u) !== undefined) {
      const entries = this.list(/^\}/u);
      return {
        kind: "group",
        entries,
        totals: entries.length > 1,
        rules: this.rules(false),
      } satisfies Expression;
    }
    if (this.take(/^\(/u) !== undefined) {
      const entries = this.list(/^\)/u);
      if (entries.length > 1 || (this.dialect === "avrae" && this.hasRank())) {
        return {
          kind: "group",
          entries,
          totals: true,
          rules: this.rules(false),
        } satisfies Expression;
      }
      return this.dice(entries[0]!) ?? entries[0]!;
    }
    const literal = this.take(/^(?:\d+(?:\.\d+)?|\.\d+)/u);
    if (literal !== undefined) {
      const value = Number(literal);
      if (!Number.isFinite(value)) throw new InvalidRoll("math");
      const atom = number(value);
      return this.dice(atom) ?? atom;
    }
    const dice = this.dice(number(1));
    if (dice !== null) return dice;
    throw new InvalidRoll("syntax");
  }

  private hasRank() {
    return /^(?:kh|kl|k|ph|pl|p)(?=[\d<>])/iu.test(this.rest);
  }

  private list(close: RegExp) {
    const entries: Expression[] = [this.comparison()];
    while (this.take(/^,/u) !== undefined) {
      if (this.take(close) !== undefined) return entries;
      entries.push(this.comparison());
    }
    this.require(close);
    return entries;
  }

  private dice(count: Expression) {
    const die = this.take(/^[dk](?=\s*[\d(f%])/iu);
    if (die === undefined) return null;
    this.rest = this.rest.trimStart();
    let faces: Extract<Expression, { kind: "dice" }>["faces"];
    if (this.take(/^%/u) !== undefined) faces = this.dialect === "avrae" ? "tens" : number(100);
    else if (this.take(/^f\.1/iu) !== undefined) faces = "fudge";
    else if (this.take(/^f(?:\.2)?/iu) !== undefined) faces = "fate";
    else if (this.take(/^\(/u)) {
      faces = this.comparison();
      this.require(/^\)/u);
    } else faces = number(this.integer());
    const rules = this.rules(true);
    if (count.kind === "number") {
      const amount = Math.round(count.value);
      this.baseDice += amount;
      if (amount < 0 || this.baseDice > MAX_DICE) throw new InvalidRoll("count");
      if (
        faces !== "fate" &&
        faces !== "fudge" &&
        faces !== "tens" &&
        faces.kind === "number" &&
        (faces.value < Number(amount > 0) || faces.value > MAX_SIDES)
      ) {
        throw new InvalidRoll("sides");
      }
      const changesSize = rules.some(({ kind }) => kind === "explode");
      if (
        !changesSize &&
        this.dialect === "roll20" &&
        rules.some((rule) => (rule.kind === "keep" || rule.kind === "drop") && rule.count > amount)
      )
        throw new InvalidRoll("rule");
    }
    return { kind: "dice", count, faces, rules } satisfies Expression;
  }

  private integer(optional?: false): number;
  private integer(optional: true): number | undefined;
  private integer(optional = false) {
    const digits = this.take(/^[-−]?\d+/u, false);
    if (digits === undefined) {
      if (!optional) throw new InvalidRoll("syntax");
      return;
    }
    const result = Number(digits.replace("−", "-"));
    if (!Number.isSafeInteger(result)) throw new InvalidRoll("math");
    return result;
  }

  private target(
    fallback: Check | null = null,
    spaced = false,
    inclusive = this.dialect === "roll20" || this.dialect === "maiden",
  ) {
    const symbolic = this.take(/^(?:>=|<=|<>|==|!=|[=<>])/u, spaced);
    const target = this.integer(true);
    if (symbolic === undefined && target === undefined) return fallback;
    if (target === undefined) throw new InvalidRoll("syntax");
    return check(comparisonOperator(symbolic, inclusive), target);
  }

  private rules(dice: boolean) {
    const rules: Rule[] = [];
    for (;;) {
      const label = this.take(/^\[(?!\[)[^\]\r\n]*\]/u, false);
      if (label !== undefined) continue;
      const pattern =
        /^(?:count|even|odd|min|max|mi|ma|cs|cf|df|sf|ms|kh|kl|km|dh|dl|ph|pl|adv|dis|irg|irx|ir|rg|rx|ro|rr|uo|xo|ra|ie|mt|sa|sd|sl|tl|ds|!!p|!!|!p|!|[kdrxetfcbpmusai])/iu;
      const word = this.rest.trimStart();
      const candidate = pattern.exec(word)?.[0];
      const spaced = word !== this.rest;
      const separated = candidate !== undefined && !/^[a-z]/iu.test(word.slice(candidate.length));
      const comment = this.dialect === "maiden" && word.startsWith("!");
      const modifier = !spaced || (separated && !comment) ? this.take(pattern) : undefined;
      if (modifier !== undefined) {
        if (this.dialect === "rolisteam" && modifier === "K") {
          if (!dice) throw new InvalidRoll("rule");
          rules.push({
            kind: "explode",
            cap: MAX_DRAWS,
            compound: true,
            firstOnly: false,
            penetrate: false,
            check: null,
          });
        }
        rules.push(this.rule(modifier, dice));
        continue;
      }
      if (this.dialect !== "avrae" && /^\s*[=<>]/u.test(this.rest)) {
        rules.push({ kind: "score", check: this.target(null, true)!, failure: false });
        continue;
      }
      return rules;
    }
  }

  private rule: (raw: string, dice: boolean) => Rule = (raw, dice) => {
    const word = raw.toLowerCase();
    switch (word) {
      case "kh":
      case "kl":
      case "dh":
      case "dl":
      case "ph":
      case "pl":
      case "k":
      case "d":
      case "p": {
        if (this.dialect === "avrae" && (word === "k" || word === "p")) {
          const target = this.target();
          if (target === null) throw new InvalidRoll("rule");
          return { kind: word === "k" ? "select" : "exclude", check: target };
        }
        if (word === "p") throw new InvalidRoll("rule");
        const count = this.integer(true) ?? 1;
        if (count < 1 || count > MAX_DRAWS) throw new InvalidRoll("rule");
        return {
          kind: word.startsWith("k") ? "keep" : "drop",
          count,
          high: word === "k" || word.endsWith("h"),
        };
      }
      case "adv":
      case "dis":
      case "km": {
        const count = this.integer(true) ?? 1;
        if (count < 1 || count > MAX_DICE || (word !== "km" && !dice))
          throw new InvalidRoll("rule");
        return word === "km"
          ? { kind: "middle", count }
          : { kind: "bonus", count: word === "adv" ? count : -count };
      }
      case "r":
      case "rr":
      case "ro":
      case "ir":
      case "irg":
      case "irx":
      case "rg":
      case "rx":
      case "u":
      case "uo": {
        if (!dice) throw new InvalidRoll("rule");
        const once =
          word === "ro" ||
          word === "uo" ||
          word === "rx" ||
          word === "rg" ||
          (raw !== "R" &&
            word === "r" &&
            ["foundry", "maiden", "rolisteam"].includes(this.dialect));
        const unique = word.startsWith("u");
        const bracketed = this.take(/^\[/u, false) !== undefined;
        const fallback = unique ? check("any") : check("=", 1);
        const target =
          word === "rr" ? this.target(fallback, false, false)! : this.target(fallback)!;
        if (bracketed) this.require(/^\]/u);
        if (target.op === "=") {
          if (word === "rg" || word === "irg") target.op = ">=";
          if (word === "ir" || (this.dialect === "maiden" && word === "r")) target.op = "<=";
        }
        return { kind: unique ? "unique" : "reroll", once, check: target };
      }
      case "!":
      case "!!":
      case "!p":
      case "!!p":
      case "x":
      case "xo":
      case "e":
      case "ie":
      case "a":
      case "ra": {
        if (!dice) throw new InvalidRoll("rule");
        let cap =
          word === "xo" ||
          word === "ra" ||
          word === "a" ||
          (word === "e" && this.dialect === "maiden")
            ? 1
            : MAX_DRAWS;
        let bracketed = this.take(/^\[/u, false) !== undefined;
        if (word === "e" && this.take(/^\(/u, false) !== undefined) {
          cap = this.integer();
          this.require(/^\)/u);
          bracketed = this.take(/^\[/u, false) !== undefined;
        }
        const limited = word === "x" && /^\d+(?=[=<>])/u.test(this.rest);
        if (limited) cap = this.integer();
        const target =
          word === "x" || word === "xo" ? this.target(null, false, false) : this.target();
        if (bracketed) this.require(/^\]/u);
        if (cap < 0 || cap > MAX_DRAWS) throw new InvalidRoll("rule");
        return {
          kind: "explode",
          cap,
          check: target,
          compound:
            word.startsWith("!!") || word === "a" || (word === "e" && this.dialect === "rolisteam"),
          penetrate: word.endsWith("p"),
          firstOnly: word === "ra",
        };
      }
      case "count":
      case "t":
      case "tl":
      case "c":
      case "even":
      case "odd": {
        if (word === "even" || word === "odd")
          return { kind: "score", check: check(word), failure: false };
        const bracketed = word === "c" && this.take(/^\[/u, false) !== undefined;
        const target = bracketed ? this.target(null, true, false) : this.target();
        if (target === null) throw new InvalidRoll("rule");
        if (bracketed) this.require(/^\]/u);
        if (word === "count" && /^[+-](?!\s*\d)/u.test(this.rest)) {
          target.op = this.rest.startsWith("+") ? ">=" : "<=";
          this.rest = this.rest.slice(1);
        } else if ((word === "t" || word === "tl") && target.op === "=") {
          target.op = word === "t" ? ">=" : "<=";
        }
        return { kind: "score", check: target, failure: false };
      }
      case "cs":
      case "cf": {
        const explicitInclusive = /^[<>]=/u.test(this.rest);
        const target = this.target();
        if (this.dialect === "foundry" || (this.dialect === "roll20" && explicitInclusive)) {
          return { kind: "score", check: target ?? check("any"), failure: word === "cf" };
        }
        return { kind: word === "cs" ? "critical" : "botch", check: target };
      }
      case "b": {
        const target = this.target(check("<=", 1))!;
        if (target.op === "=") target.op = "<=";
        return { kind: "botch", check: target };
      }
      case "f":
      case "df":
      case "sf": {
        if (word === "f" && this.take(/^\[/u, false) !== undefined) {
          const target = this.target(null, true);
          this.require(/^\]/u);
          if (target === null) throw new InvalidRoll("rule");
          return { kind: "select", check: target };
        }
        const target =
          word === "f" ? this.target(check("=", 1))! : this.target(check("=", 1), false, false)!;
        if (word === "f" && this.dialect === "maiden" && target.op === "=") target.op = "<=";
        return { kind: word === "sf" ? "subtract" : "deduct", check: target, failure: true };
      }
      case "min":
      case "mi":
      case "max":
      case "ma":
      case "ms":
        return {
          kind: word.startsWith("mi") ? "minimum" : word.startsWith("ma") ? "maximum" : "margin",
          target: this.integer(),
        };
      case "ds": {
        const target = this.target(check("any"))!;
        if (target.op === "=") target.op = ">=";
        return { kind: "double", count: 1, check: target };
      }
      case "m":
      case "mt":
        return {
          kind: word === "mt" ? "tally" : "matches",
          count: this.integer(true) ?? 2,
          check: this.target(check("any"))!,
        };
      case "s":
      case "sa":
      case "sd":
      case "sl":
        return {
          kind: "sort",
          descending: word === "sd" || (word === "s" && this.dialect === "rolisteam"),
        };
      default:
        throw new InvalidRoll("rule");
    }
  };
}

export const parseExpression: (expression: string) => Formula | { error: ExpressionError } = (
  expression,
) => {
  if (expression.length > MAX_EXPRESSION_LENGTH) return { error: "length" } as const;
  let text = expression.trim();
  const prefix = /^(roll20|foundry|avrae|rpg|maiden|rolisteam):\s*/iu.exec(text);
  const dialect = DIALECTS.find((value) => value === prefix?.[1]?.toLowerCase()) ?? "roll20";
  if (prefix !== null) text = text.slice(prefix[0].length);
  try {
    const root = new Parser(text, dialect).read();
    return {
      dialect,
      legacy: dialect === "roll20" ? legacyNotation(text) : null,
      root,
    } satisfies Formula;
  } catch (error) {
    if (error instanceof InvalidRoll) return { error: error.reason };
    throw error;
  }
};
