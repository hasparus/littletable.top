import type { DieKind } from "../../client/src/dice-solids";

import { hashThrow, simulate } from "../../client/src/dice-physics";

export function hash(kinds: DieKind[], seed: number): string {
  return hashThrow(simulate(kinds, seed));
}
