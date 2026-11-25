import { T } from "@tldraw/validate";

import { isGizmoAssetUrl } from "./gizmo-packages";

const deckArt = T.string.check((src) => {
  if (!isGizmoAssetUrl(src)) throw new Error("Invalid deck art");
});

export const deckPlaced = T.object({ deck: T.string });

export const deckRevealed = T.object({
  card: T.string,
  name: T.string,
  width: T.positiveNumber,
});

export type DeckReveal = T.TypeOf<typeof deckRevealed>;

export const deckStack = T.object({
  deckId: T.string,
  deckBack: deckArt,
  deckRemaining: T.positiveInteger,
  deckSize: T.positiveInteger,
}).allowUnknownProperties();

export const dealtDeckCard = T.object({
  deckId: T.string,
  deckFace: deckArt,
  deckBack: deckArt,
  deckDealtAt: T.number,
  deckTravelX: T.number,
  deckTravelY: T.number,
}).allowUnknownProperties();
