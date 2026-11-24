import { DIE_SIDES, MAX_DICE } from "./limits";

export type { Roll } from "./dice-notation";

export function parsePool(body: unknown): number[] | null {
  const dice = (body as { dice?: unknown } | null)?.dice;
  if (!Array.isArray(dice) || dice.length === 0 || dice.length > MAX_DICE) return null;
  const sides: readonly number[] = DIE_SIDES;
  return dice.every((die) => sides.includes(die)) ? dice : null;
}

// Rejection sampling: a plain modulo would favour the low faces.
export function rollDie(sides: number): number {
  const limit = 2 ** 32 - (2 ** 32 % sides);
  const draw = new Uint32Array(1);
  do crypto.getRandomValues(draw);
  while (draw[0]! >= limit);
  return (draw[0]! % sides) + 1;
}

// An unsigned 32-bit seed for the shared throw, drawn on its own so it says
// nothing about the values.
export function drawSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export function addRollColumns(sql: SqlStorage) {
  const columns = new Set(
    sql
      .exec("SELECT name FROM pragma_table_info('rolls')")
      .toArray()
      .map(({ name }) => name),
  );
  if (!columns.has("seed")) sql.exec("ALTER TABLE rolls ADD COLUMN seed INTEGER");
  if (!columns.has("expression")) sql.exec("ALTER TABLE rolls ADD COLUMN expression TEXT");
}
