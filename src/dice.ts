import { DIE_SIDES, MAX_DICE } from "./limits";

export type Roll = {
  at: number;
  dice: { sides: number; value: number }[];
  id: number;
  name: string;
  // Shapes the throw every client animates; null on rolls logged before
  // seeds existed. Values never derive from it.
  seed: number | null;
  sub: string;
};

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

// Rooms created before seeds keep their log: the column is added in place
// and their rows read back with a null seed.
export function addSeedColumn(sql: SqlStorage) {
  const columns = sql.exec("SELECT name FROM pragma_table_info('rolls')").toArray();
  if (!columns.some((column) => column.name === "seed")) {
    sql.exec("ALTER TABLE rolls ADD COLUMN seed INTEGER");
  }
}
