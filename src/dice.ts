import type { DiceLaunch } from "./dice-notation";

import { DIE_SIDES, MAX_DICE } from "./limits";

export { rollDie } from "./roll-die";
export type { Roll } from "./dice-notation";

export function parsePool(body: unknown): number[] | null {
  const dice = (body as { dice?: unknown } | null)?.dice;
  if (!Array.isArray(dice) || dice.length === 0 || dice.length > MAX_DICE) return null;
  const sides: readonly number[] = DIE_SIDES;
  return dice.every((die) => sides.includes(die)) ? dice : null;
}

const fraction = (n: unknown): n is number => typeof n === "number" && Math.abs(n) <= 1;

export function parseLaunch(value: unknown): DiceLaunch | null {
  if (typeof value !== "object" || value === null) return null;
  const { vx, vz, x, z } = value as Partial<DiceLaunch>;
  return fraction(vx) && fraction(vz) && fraction(x) && fraction(z) ? { vx, vz, x, z } : null;
}

/** Draws an animation seed independently of the dice values. */
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
  if (!columns.has("outcome")) sql.exec("ALTER TABLE rolls ADD COLUMN outcome TEXT");
  if (!columns.has("chat")) sql.exec("ALTER TABLE rolls ADD COLUMN chat INTEGER");
}
