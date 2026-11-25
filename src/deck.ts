import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import { AssetRecordType, idValidator, pageIdValidator } from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { T } from "@tldraw/validate";

import type { InstalledGizmo } from "./gizmo-packages";

import { dealtDeckCard, type DeckReveal, deckStack } from "./deck-records";
import { rollDie } from "./roll-die";

type ResolvePackage = (url: string) => InstalledGizmo | null;

type BoardImage = Extract<TLRecord, { type: "image"; typeName: "shape" }>;
type Drawing = {
  get: (id: TLRecord["id"]) => TLRecord | undefined;
  set: (id: TLRecord["id"], record: TLRecord) => void;
  values: () => Iterable<TLRecord>;
};
export type DeckState = {
  install: string;
  remaining: number[];
  recent: { id: string; reveal: DeckReveal }[];
};

type Decks = {
  get: (key: string) => DeckState | undefined;
  set: (key: string, state: DeckState) => void;
};

const imageId = idValidator<BoardImage["id"]>("shape");
const RECENT_DRAWS = 16;
const deckKey = (id: string) => `gizmoDeck:${id}`;

const requestId = T.string.check((id) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error("Invalid deck request ID");
  }
});
const language = T.literalEnum("en", "pl");
const deckPoint = T.object({ x: T.number, y: T.number });

const deckPlace = T.object({
  action: T.literal("place"),
  height: T.number.check((height) => {
    if (height < 1 || height > 40_000) throw new Error("Invalid deck height");
  }),
  id: requestId,
  install: T.string,
  language,
  page: pageIdValidator,
  point: deckPoint,
});

const deckDeal = T.object({
  action: T.literal("draw"),
  deck: imageId,
  id: requestId,
  language,
  origin: deckPoint,
  page: pageIdValidator,
  point: deckPoint,
  precise: T.boolean,
});

export const deckCommand = T.union("action", { place: deckPlace, draw: deckDeal });

export type DeckCommand = T.TypeOf<typeof deckCommand>;
type DeckPlacement = T.TypeOf<typeof deckPlace>;
type DeckDeal = T.TypeOf<typeof deckDeal>;

function shuffledCards(size: number) {
  const deck = Array.from({ length: size }, (_, index) => index);
  for (let end = deck.length - 1; end > 0; end--) {
    const index = rollDie(end + 1) - 1;
    [deck[end], deck[index]] = [deck[index]!, deck[end]!];
  }
  return deck;
}

function topIndex(drawing: Drawing, page: TLPageId) {
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
  return getIndexAbove(top);
}

function addImage(
  drawing: Drawing,
  {
    id,
    height,
    sourceHeight,
    meta,
    name,
    page,
    point,
    src,
    width,
  }: {
    id: string;
    height: number;
    sourceHeight: number;
    meta: BoardImage["meta"];
    name: string;
    page: TLPageId;
    point: T.TypeOf<typeof deckPoint>;
    src: string;
    width: number;
  },
) {
  const asset = AssetRecordType.create({
    id: AssetRecordType.createId(`gizmo-deck-${id}`),
    props: { h: sourceHeight, isAnimated: false, mimeType: null, name, src, w: width },
    type: "image",
  });
  const w = (height * width) / sourceHeight;
  const image: BoardImage = {
    id: imageId.validate(`shape:gizmo-deck-${id}`),
    index: topIndex(drawing, page),
    isLocked: false,
    meta,
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
      w,
    },
    rotation: 0,
    type: "image",
    typeName: "shape",
    x: point.x - w / 2,
    y: point.y - height / 2,
  };
  drawing.set(asset.id, asset);
  drawing.set(image.id, image);
}

function placeDeck(
  drawing: Drawing,
  storage: Decks,
  resolve: ResolvePackage,
  command: DeckPlacement,
) {
  const { id, install, language, page, height, point } = command;
  const deckId = imageId.validate(`shape:gizmo-deck-${id}`);
  const current = storage.get(deckKey(deckId));
  if (current !== undefined) return current.install === install ? { deck: deckId } : null;
  const found = resolve(install);
  if (found?.manifest.kind !== "deck" || drawing.get(page)?.typeName !== "page") return null;
  const { manifest } = found;
  addImage(drawing, {
    height,
    sourceHeight: manifest.cardHeight,
    id,
    meta: {
      deckId,
      deckBack: manifest.back,
      deckRemaining: manifest.cards.length,
      deckSize: manifest.cards.length,
    },
    name: manifest.name[language],
    page,
    point,
    src: manifest.back,
    width: manifest.backWidth,
  });
  storage.set(deckKey(deckId), {
    install,
    recent: [],
    remaining: shuffledCards(manifest.cards.length),
  } satisfies DeckState);
  return { deck: deckId };
}

function deckIsOnPage(drawing: Drawing, boardImage: BoardImage, page: TLPageId) {
  let parent = drawing.get(boardImage.parentId);
  const seen = new Set<TLRecord["id"]>();
  while (parent?.typeName === "shape" && !seen.has(parent.id)) {
    seen.add(parent.id);
    parent = drawing.get(parent.parentId);
  }
  return parent?.id === page;
}

function dealPoint(drawing: Drawing, command: DeckDeal, height: number) {
  const { deck, page, point } = command;
  if (command.precise) return point;
  const used = [...drawing.values()].filter(
    (record) =>
      record.typeName === "shape" &&
      record.type === "image" &&
      record.parentId === page &&
      dealtDeckCard.isValid(record.meta) &&
      record.meta.deckId === deck,
  );
  const step = height * 0.11;
  let { y } = point;
  let slotsLeft = 4;
  while (slotsLeft > 0) {
    const occupied = used.some((record) => {
      if (record.typeName !== "shape" || record.type !== "image") return false;
      return (
        Math.abs(record.x + record.props.w / 2 - point.x) < step / 2 &&
        Math.abs(record.y + record.props.h / 2 - y) < step / 2
      );
    });
    if (!occupied) break;
    y += step;
    slotsLeft--;
  }
  return { x: point.x, y };
}

function drawDeck(drawing: Drawing, storage: Decks, resolve: ResolvePackage, command: DeckDeal) {
  const { deck, id, language, page } = command;
  const state = storage.get(deckKey(deck));
  if (state === undefined) return null;
  const previous = state.recent.find((entry) => entry.id === id);
  if (previous !== undefined) return previous.reveal;
  const stack = drawing.get(deck);
  if (
    stack?.typeName !== "shape" ||
    stack.type !== "image" ||
    !deckStack.isValid(stack.meta) ||
    stack.meta.deckId !== stack.id ||
    !deckIsOnPage(drawing, stack, page)
  )
    return null;

  const found = resolve(state.install);
  if (found?.manifest.kind !== "deck") return null;
  const { manifest } = found;
  const remaining =
    state.remaining.length === 0 ? shuffledCards(manifest.cards.length) : [...state.remaining];
  const card = manifest.cards[remaining.pop()!];
  if (card === undefined) return null;
  const name = card.name[language];
  const { h: height } = stack.props;
  const destination = dealPoint(drawing, command, height);
  addImage(drawing, {
    height,
    sourceHeight: manifest.cardHeight,
    id: `${deck.slice("shape:".length)}-${id}`,
    meta: {
      deckId: deck,
      deckBack: manifest.back,
      deckDealtAt: Date.now(),
      deckFace: card.src,
      deckTravelX: command.precise ? 0 : command.origin.x - destination.x,
      deckTravelY: command.precise ? 0 : command.origin.y - destination.y,
    },
    name,
    page,
    point: destination,
    src: card.src,
    width: card.width,
  });
  drawing.set(stack.id, { ...stack, meta: { ...stack.meta, deckRemaining: remaining.length } });
  const reveal = { card: card.id, name, width: card.width };
  const recent = [...state.recent, { id, reveal }].slice(-RECENT_DRAWS);
  storage.set(deckKey(deck), { ...state, recent, remaining });
  return reveal;
}

export function changeDeck(
  drawing: Drawing,
  storage: Decks,
  resolve: ResolvePackage,
  command: DeckCommand,
) {
  return command.action === "place"
    ? placeDeck(drawing, storage, resolve, command)
    : drawDeck(drawing, storage, resolve, command);
}
