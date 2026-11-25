import type { TLSyncStorageTransaction } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";

import { AssetRecordType, idValidator, pageIdValidator } from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { T } from "@tldraw/validate";

import { rollDie } from "./dice";
import { TAROT_CARDS, TAROT_HEIGHT, tarotImage, type TarotReveal } from "./tarot-cards";

export const tarotDraw = T.object({
  height: T.number.check((height) => {
    if (height < 1 || height > 40_000) throw new Error("Invalid tarot card height");
  }),
  id: T.string.check((id) => {
    if (!/^[a-f\d-]{36}$/u.test(id)) throw new Error("Invalid tarot request ID");
  }),
  language: T.literalEnum("en", "pl"),
  page: pageIdValidator,
  x: T.number,
  y: T.number,
});

export type TarotDraw = T.TypeOf<typeof tarotDraw>;

type BoardImage = Extract<TLRecord, { type: "image"; typeName: "shape" }>;
type Deck = { remaining: number[]; recent: { id: string; reveal: TarotReveal }[] };

const imageId = idValidator<BoardImage["id"]>("shape");
const DECK_KEY = "rws1909Deck";
const RECENT_DRAWS = 16;

function shuffledCards() {
  const deck = TAROT_CARDS.map((_, index) => index);
  for (let end = deck.length - 1; end > 0; end--) {
    const index = rollDie(end + 1) - 1;
    [deck[end], deck[index]] = [deck[index]!, deck[end]!];
  }
  return deck;
}

export function revealTarot(
  drawing: TLSyncStorageTransaction<TLRecord>,
  storage: DurableObjectStorage,
  draw: TarotDraw,
) {
  const { id, language, page, x, y, height } = draw;
  const deck = storage.kv.get<Deck>(DECK_KEY);
  const previous = deck?.recent.find((entry) => entry.id === id);
  if (previous !== undefined) return previous.reveal;
  if (drawing.get(page)?.typeName !== "page") return null;

  const remaining = deck?.remaining.length ? deck.remaining : shuffledCards();
  const card = TAROT_CARDS[remaining.pop()!]!;
  const name = card[language];
  const asset = AssetRecordType.create({
    id: AssetRecordType.createId(`tarot-${id}`),
    props: {
      h: TAROT_HEIGHT,
      isAnimated: false,
      mimeType: "image/webp",
      name,
      src: tarotImage(card.id),
      w: card.width,
    },
    type: "image",
  });
  let top: IndexKey | null = null;
  for (const record of drawing.values()) {
    if (
      record.typeName === "shape" &&
      record.parentId === page &&
      (top === null || record.index > top)
    ) {
      top = record.index;
    }
  }
  const width = (height * card.width) / TAROT_HEIGHT;
  const image: BoardImage = {
    id: imageId.validate(`shape:tarot-${id}`),
    index: getIndexAbove(top),
    isLocked: false,
    meta: {},
    opacity: 1,
    parentId: page,
    props: {
      altText: name,
      assetId: asset.id,
      crop: null,
      flipX: false,
      flipY: false,
      h: height,
      playing: false,
      url: "",
      w: width,
    },
    rotation: 0,
    type: "image",
    typeName: "shape",
    x: x - width / 2,
    y: y - height / 2,
  };
  drawing.set(asset.id, asset);
  drawing.set(image.id, image);
  const reveal = { card: card.id, name, width: card.width };
  const recent = [...(deck?.recent ?? []), { id, reveal }].slice(-RECENT_DRAWS);
  storage.kv.put(DECK_KEY, { recent, remaining });
  return reveal;
}
