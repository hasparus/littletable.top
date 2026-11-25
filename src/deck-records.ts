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

const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export function isDealtCardId(deck: string, card: string) {
  const deckPrefix = "shape:gizmo-deck-";
  if (!deck.startsWith(deckPrefix) || !requestId.test(deck.slice(deckPrefix.length))) return false;
  const cardPrefix = `${deckPrefix}${deck.slice("shape:".length)}-`;
  return card.startsWith(cardPrefix) && requestId.test(card.slice(cardPrefix.length));
}

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
  deckTurnedAt: T.number.optional(),
}).allowUnknownProperties();

export const cardFlightDuration = T.number.check((duration) => {
  if (duration <= 0 || duration > 500) throw new Error("Invalid card flight duration");
});

export const dealtDeckCard = T.object({
  deckId: T.string,
  deckFace: deckArt,
  deckBack: deckArt,
  deckDealtAt: T.number,
  deckTravelX: T.number,
  deckTravelY: T.number,
  deckFlightDuration: cardFlightDuration.optional(),
  deckTurnedAt: T.number.optional(),
  deckCardId: T.string.optional(),
  deckFaceId: T.string.optional(),
}).allowUnknownProperties();
