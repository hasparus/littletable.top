import { idValidator, type TLRecord } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

import { isGizmoAssetUrl } from "./gizmo-packages";

const deckArt = T.string.check((src) => {
  if (!isGizmoAssetUrl(src)) throw new Error("Invalid deck art");
});

type ImageId = Extract<TLRecord, { typeName: "shape"; type: "image" }>["id"];
const cardId = idValidator<ImageId>("shape");
export const deckPlaced = T.object({ deck: cardId });
export const deckPrepared = T.object({ face: deckArt });
export const deckCancelled = T.object({ cancelled: T.literal(true) });
export const deckDropped = T.object({ card: cardId, faceDown: T.literal(true) });
export type DeckDropResult = T.TypeOf<typeof deckDropped>;

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

export const faceDownDeckCard = T.object({
  deckId: T.string,
  deckBack: deckArt,
  deckCardId: T.string,
  deckDown: T.literal(true),
}).allowUnknownProperties();

export const dealtDeckCard = T.object({
  deckId: T.string,
  deckFace: deckArt,
  deckBack: deckArt,
  deckDealtAt: T.number,
  deckTravelX: T.number,
  deckTravelY: T.number,
  deckTurnedAt: T.number.optional(),
  deckCardId: T.string.optional(),
  deckFaceId: T.string.optional(),
}).allowUnknownProperties();
