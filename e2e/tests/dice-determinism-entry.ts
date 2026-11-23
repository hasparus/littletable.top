// What dice-determinism.spec.ts bundles into each browser: the client's own
// simulation, exposed as one function.

import type { DieKind } from "../../client/src/dice-solids";

import { hashThrow, simulate } from "../../client/src/dice-physics";

export function hash(kinds: DieKind[], seed: number): string {
  return hashThrow(simulate(kinds, seed));
}
