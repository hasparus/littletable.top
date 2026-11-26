import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import { AssetRecordType, idValidator, pageIdValidator } from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { T } from "@tldraw/validate";

import type { DeckManifest, InstalledGizmo } from "./gizmo-packages";

import {
  cardFlightDuration,
  cardFlightRotation,
  dealtDeckCard,
  type DeckDropResult,
  type DeckReveal,
  deckStack,
  faceDownDeckCard,
  isDealtCardId,
} from "./deck-records";
import { rollDie } from "./roll-die";

type ResolvePackage = (url: string) => InstalledGizmo | null;

type BoardImage = Extract<TLRecord, { type: "image"; typeName: "shape" }>;
type Drawing = {
  get: (id: TLRecord["id"]) => TLRecord | undefined;
  set: (id: TLRecord["id"], record: TLRecord) => void;
  values: () => Iterable<TLRecord>;
};
type Reservation = { id: string; page: TLPageId; until: number };
type StackState = {
  install: string;
  remaining: number[];
  recent: { id: string; reveal: DeckReveal | DeckDropResult }[];
  grids?: Partial<Record<TLPageId, FixedDeckGrid>>;
  reservation?: Reservation;
  closed?: string[];
};
type CardIdentity = { install: string; index: number; originalName?: string };
export type DeckState = StackState | { face: CardIdentity };

type Decks = {
  get: (key: string) => DeckState | undefined;
  set: (key: string, state: DeckState) => void;
  delete: (key: string) => void;
};

const imageId = idValidator<BoardImage["id"]>("shape");
const RECENT_DRAWS = 16;
const PICKUP_TIMEOUT = 90_000;
const deckKey = (id: string) => `gizmoDeck:${id}`;
const cardKey = (id: string) => `gizmoDeckCard:${id}`;

const requestId = T.string.check((id) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error("Invalid deck request ID");
  }
});
const language = T.literalEnum("en", "pl");
const deckPoint = T.object({ x: T.number, y: T.number });

const gridStep = T.number.check((step) => {
  if (step <= 0 || step > 1_000_000) throw new Error("Invalid deck grid spacing");
});
const deckGrid = T.object({
  x: T.number,
  y: T.number,
  columns: T.positiveInteger.check((columns) => {
    if (columns < 1 || columns > 3) throw new Error("Invalid deck grid columns");
  }),
  stepX: gridStep,
  stepY: gridStep,
});

export type DeckGrid = T.TypeOf<typeof deckGrid>;
type FixedDeckGrid = DeckGrid & { height: number; width: number };

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
  faceDown: T.boolean.optional(),
  flight: T.object({
    duration: cardFlightDuration,
    rotation: cardFlightRotation.optional(),
  }).optional(),
  grid: deckGrid.optional(),
  id: requestId,
  language,
  origin: deckPoint,
  page: pageIdValidator,
  point: deckPoint,
  precise: T.boolean,
  prepared: T.boolean.optional(),
});

const deckWarm = T.object({ action: T.literal("warm"), deck: imageId, page: pageIdValidator });

const deckPrepare = T.object({
  action: T.literal("prepare"),
  deck: imageId,
  id: requestId,
  language,
  page: pageIdValidator,
});

const deckCancel = T.object({
  action: T.literal("cancel"),
  deck: imageId,
  id: requestId,
  page: pageIdValidator,
});

const deckFlip = T.object({
  action: T.literal("flip"),
  card: imageId,
  faceDown: T.boolean.optional(),
  language,
  page: pageIdValidator,
});

export const deckCommand = T.union("action", {
  place: deckPlace,
  draw: deckDeal,
  warm: deckWarm,
  prepare: deckPrepare,
  cancel: deckCancel,
  flip: deckFlip,
});

export type DeckCommand = T.TypeOf<typeof deckCommand>;
type DeckPlacement = T.TypeOf<typeof deckPlace>;
type DeckDeal = T.TypeOf<typeof deckDeal>;
type DeckPrepare = T.TypeOf<typeof deckPrepare>;
type DeckCancel = T.TypeOf<typeof deckCancel>;
type DeckFlip = T.TypeOf<typeof deckFlip>;

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

function deckImageId(id: string) {
  return imageId.validate(`shape:gizmo-deck-${id}`);
}

function dealtKey(deck: string, requestId: string) {
  return `${deck.slice("shape:".length)}-${requestId}`;
}

export function dealtCardId(deck: string, requestId: string) {
  return deckImageId(dealtKey(deck, requestId));
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
    rotation = 0,
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
    rotation?: number;
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
    id: deckImageId(id),
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
    rotation,
    type: "image",
    typeName: "shape",
    x: point.x - (w * Math.cos(rotation) - height * Math.sin(rotation)) / 2,
    y: point.y - (w * Math.sin(rotation) + height * Math.cos(rotation)) / 2,
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
  const deckId = deckImageId(id);
  const current = stackState(storage, deckId);
  if (current !== null) return current.install === install ? { deck: deckId } : null;
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
  } satisfies StackState);
  return { deck: deckId };
}

type BoardPiece = Extract<TLRecord, { typeName: "shape" }>;

function pagePlacement(drawing: Drawing, piece: BoardPiece, page: TLPageId) {
  let { x, y, rotation, isLocked } = piece;
  let parent = drawing.get(piece.parentId);
  const seen = new Set<TLRecord["id"]>();
  while (parent?.typeName === "shape" && !seen.has(parent.id)) {
    seen.add(parent.id);
    const cos = Math.cos(parent.rotation);
    const sin = Math.sin(parent.rotation);
    [x, y] = [parent.x + x * cos - y * sin, parent.y + x * sin + y * cos];
    rotation += parent.rotation;
    isLocked ||= parent.isLocked;
    parent = drawing.get(parent.parentId);
  }
  return parent?.id === page ? { x, y, rotation, isLocked } : null;
}

function occupiedBounds(drawing: Drawing, page: TLPageId) {
  const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const record of drawing.values()) {
    if (record.typeName !== "shape") continue;
    const { props } = record;
    if (!("w" in props) || !("h" in props)) continue;
    const placement = pagePlacement(drawing, record, page);
    if (placement === null) continue;
    const { x, y, rotation } = placement;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const dx1 = props.w * cos;
    const dx2 = -props.h * sin;
    const dy1 = props.w * sin;
    const dy2 = props.h * cos;
    occupied.push({
      left: x + Math.min(dx1, 0) + Math.min(dx2, 0),
      right: x + Math.max(dx1, 0) + Math.max(dx2, 0),
      top: y + Math.min(dy1, 0) + Math.min(dy2, 0),
      bottom: y + Math.max(dy1, 0) + Math.max(dy2, 0),
    });
  }
  return occupied;
}

function establishGrid(command: DeckDeal, height: number, width: number) {
  const gap = height * 0.07;
  const suggestion = command.grid;
  const stepX = Math.max(suggestion?.stepX ?? 0, width + gap);
  const stepY = Math.max(suggestion?.stepY ?? 0, height + gap);
  const capacity = suggestion
    ? Math.floor((suggestion.columns * suggestion.stepX) / stepX + 1e-8)
    : 1;
  const columns = Math.max(1, capacity);
  return {
    x: (suggestion?.x ?? command.point.x) + Math.max(0, stepX - (suggestion?.stepX ?? stepX)) / 2,
    y: suggestion?.y ?? command.point.y,
    columns,
    stepX,
    stepY,
    height,
    width,
  } satisfies FixedDeckGrid;
}

function firstFreeRow(occupied: ReturnType<typeof occupiedBounds>, grid: FixedDeckGrid, x: number) {
  const horizontal = occupied.filter(
    ({ left, right }) => left < x + grid.width / 2 && right > x - grid.width / 2,
  );
  const blocked = horizontal
    .map(({ top, bottom }) => ({
      first: Math.floor((top - grid.height / 2 - grid.y) / grid.stepY) + 1,
      last: Math.ceil((bottom + grid.height / 2 - grid.y) / grid.stepY) - 1,
    }))
    .sort((left, right) => left.first - right.first);
  let row = 0;
  for (const { first, last } of blocked) {
    if (first > row) break;
    if (last >= row) row = last + 1;
  }
  return row;
}

function dealPoint(drawing: Drawing, page: TLPageId, grid: FixedDeckGrid) {
  const occupied = occupiedBounds(drawing, page);
  let column = 0;
  let row = firstFreeRow(occupied, grid, grid.x);
  for (let candidate = 1; candidate < grid.columns && row > 0; candidate++) {
    const candidateRow = firstFreeRow(occupied, grid, grid.x + candidate * grid.stepX);
    if (candidateRow >= row) continue;
    row = candidateRow;
    column = candidate;
  }
  return { x: grid.x + column * grid.stepX, y: grid.y + row * grid.stepY };
}

function stackState(storage: Decks, deck: string) {
  const value = storage.get(deckKey(deck));
  return value && "remaining" in value ? value : null;
}

function playableDeck(
  drawing: Drawing,
  resolve: ResolvePackage,
  state: StackState,
  deck: BoardImage["id"],
  page: TLPageId,
) {
  const stack = drawing.get(deck);
  if (
    stack?.typeName !== "shape" ||
    stack.type !== "image" ||
    !deckStack.isValid(stack.meta) ||
    stack.meta.deckId !== stack.id
  )
    return null;
  const placement = pagePlacement(drawing, stack, page);
  const found = resolve(state.install);
  if (!placement || found?.manifest.kind !== "deck") return null;
  return { stack, placement, manifest: found.manifest };
}

function closedPickup(state: StackState, id: string) {
  return [...(state.closed ?? []).filter((closed) => closed !== id), id].slice(-RECENT_DRAWS);
}

function prepareDeck(
  drawing: Drawing,
  storage: Decks,
  resolve: ResolvePackage,
  command: DeckPrepare | T.TypeOf<typeof deckWarm>,
) {
  const { deck, page } = command;
  const state = stackState(storage, deck);
  if (!state) return null;
  const game = playableDeck(drawing, resolve, state, deck, page);
  if (!game) return null;
  const { manifest } = game;
  if (command.action === "warm") {
    const top = state.remaining.at(-1);
    const card = top === undefined ? undefined : manifest.cards[top];
    return card ? { face: card.src } : null;
  }
  const { id } = command;
  const result = priorDeal(drawing, storage, resolve, state, deck, id);
  if (result) {
    const face = "faceDown" in result ? privateFace(storage, result.card) : null;
    if (face) {
      const card = manifest.cards[face.index];
      return card ? { face: card.src } : null;
    }
    if ("faceDown" in result) {
      const image = drawing.get(result.card);
      const meta = image?.typeName === "shape" ? image.meta : null;
      return dealtDeckCard.isValid(meta) && meta.deckCardId === result.card
        ? { face: meta.deckFace }
        : null;
    }
    const card = manifest.cards.find((entry) => entry.id === result.card);
    return card ? { face: card.src } : null;
  }

  if (state.closed?.includes(id)) return null;
  const at = Date.now();
  const previous = state.reservation;
  if (previous && previous.until > at && (previous.id !== id || previous.page !== page))
    return null;
  const remaining =
    state.remaining.length === 0 ? shuffledCards(manifest.cards.length) : state.remaining;
  const card = manifest.cards[remaining.at(-1)!];
  if (!card) return null;
  storage.set(deckKey(deck), {
    ...state,
    closed: previous && previous.id !== id ? closedPickup(state, previous.id) : state.closed,
    remaining,
    reservation: { id, page, until: at + PICKUP_TIMEOUT },
  });
  return { face: card.src };
}

function cancelPickup(storage: Decks, command: DeckCancel) {
  const { deck, id, page } = command;
  const state = stackState(storage, deck);
  if (!state) return null;
  const { reservation } = state;
  if (reservation?.id === id && reservation.page !== page) return null;
  if (state.recent.some((entry) => entry.id === id)) return { cancelled: true as const };
  storage.set(deckKey(deck), {
    ...state,
    closed: closedPickup(state, id),
    reservation: reservation?.id === id ? undefined : reservation,
  });
  return { cancelled: true as const };
}

function privateFace(storage: Decks, card: string) {
  const state = storage.get(cardKey(card));
  return state && "face" in state ? state.face : undefined;
}

function priorDeal(
  drawing: Drawing,
  storage: Decks,
  resolve: ResolvePackage,
  state: StackState,
  deck: string,
  id: string,
) {
  const recent = state.recent.find((entry) => entry.id === id);
  if (recent) return recent.reveal;
  const card = dealtCardId(deck, id);
  const identity = privateFace(storage, card);
  if (identity) {
    if (!identity.originalName) return { card, faceDown: true as const };
    const found = resolve(identity.install);
    const selected = found?.manifest.kind === "deck" ? found.manifest.cards[identity.index] : null;
    if (selected) return { card: selected.id, name: identity.originalName, width: selected.width };
  }
  const image = drawing.get(card);
  if (image?.typeName !== "shape" || image.type !== "image") return null;
  const { meta } = image;
  if (!dealtDeckCard.isValid(meta) || meta.deckCardId !== card || meta.deckId !== deck) return null;
  if (meta.deckTurnedAt !== undefined) return { card, faceDown: true as const };
  return revealedResult(drawing, image);
}

function revealedResult(drawing: Drawing, image: BoardImage) {
  const { meta, props } = image;
  if (!dealtDeckCard.isValid(meta) || !meta.deckFaceId) return null;
  const asset = props.assetId === null ? undefined : drawing.get(props.assetId);
  if (asset?.typeName !== "asset" || asset.type !== "image") return null;
  return { card: meta.deckFaceId, name: props.altText, width: asset.props.w };
}

function legacyFaceIndex(
  image: BoardImage,
  asset: Extract<TLRecord, { typeName: "asset"; type: "image" }>,
  manifest: DeckManifest,
) {
  const { meta } = image;
  if (!dealtDeckCard.isValid(meta)) return -1;
  const key = image.id.slice("shape:".length);
  if (
    asset.id !== AssetRecordType.createId(key) &&
    asset.id !== AssetRecordType.createId(`gizmo-deck-face-${key}`)
  )
    return -1;
  if (meta.deckFace !== asset.props.src) return -1;
  const { name, w } = asset.props;
  const matches = manifest.cards.flatMap((candidate, index) =>
    candidate.src === asset.props.src &&
    candidate.width === w &&
    (candidate.name.en === name || candidate.name.pl === name) &&
    (meta.deckFaceId === undefined || candidate.id === meta.deckFaceId)
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
}

function flippedAsset(
  command: DeckFlip,
  manifest: DeckManifest,
  selected: DeckManifest["cards"][number],
  name: string,
) {
  return AssetRecordType.create({
    id: AssetRecordType.createId(
      `gizmo-deck-${command.faceDown ? "back" : "face"}-${command.card.slice("shape:".length)}`,
    ),
    props: {
      h: manifest.cardHeight,
      isAnimated: false,
      mimeType: null,
      name,
      src: command.faceDown ? manifest.back : selected.src,
      w: command.faceDown ? manifest.backWidth : selected.width,
    },
    type: "image",
  });
}

function flipDeck(drawing: Drawing, storage: Decks, resolve: ResolvePackage, command: DeckFlip) {
  const { card, page, language } = command;
  const image = drawing.get(card);
  if (image?.typeName !== "shape" || image.type !== "image") return null;
  const placement = pagePlacement(drawing, image, page);
  if (!placement || placement.isLocked) return null;
  const { meta, props } = image;
  const wasDown = faceDownDeckCard.isValid(meta);
  if (!wasDown && !dealtDeckCard.isValid(meta)) return null;
  if (
    !isDealtCardId(meta.deckId, card) ||
    (meta.deckCardId !== undefined && meta.deckCardId !== card)
  )
    return null;
  const identity = privateFace(storage, card);
  const install = identity?.install ?? stackState(storage, meta.deckId)?.install;
  if (install === undefined) return null;
  const found = resolve(install);
  if (found?.manifest.kind !== "deck" || meta.deckBack !== found.manifest.back) return null;
  const { manifest } = found;
  const previousAsset = props.assetId === null ? undefined : drawing.get(props.assetId);
  if (previousAsset?.typeName !== "asset" || previousAsset.type !== "image") return null;
  const index = identity?.index ?? (wasDown ? -1 : legacyFaceIndex(image, previousAsset, manifest));
  const selected = manifest.cards[index];
  if (!selected || previousAsset.props.src !== (wasDown ? manifest.back : selected.src))
    return null;

  const down = command.faceDown === true;
  const name = down
    ? language === "pl"
      ? "Zakryta karta"
      : "Face-down card"
    : selected.name[language];
  const response = down
    ? { card, faceDown: true as const }
    : { card: selected.id, name: wasDown ? name : props.altText, width: selected.width };
  if (down === wasDown) return response;

  if (!identity) {
    storage.set(cardKey(card), {
      face: {
        install,
        index,
        originalName: meta.deckTurnedAt === undefined ? previousAsset.props.name : undefined,
      },
    });
  }

  const turnedAt = Date.now();
  const asset = flippedAsset(command, manifest, selected, name);
  const {
    deckDown: _down,
    deckFace: _face,
    deckFaceId: _id,
    deckDealtAt: _dealt,
    deckTravelX: _x,
    deckTravelY: _y,
    deckFlightDuration: _flight,
    deckFlightRotation: _spin,
    ...previous
  } = image.meta;
  drawing.set(asset.id, asset);
  drawing.set(image.id, {
    ...image,
    meta: {
      ...previous,
      deckCardId: card,
      deckTurnedAt: turnedAt,
      ...(down
        ? { deckDown: true }
        : {
            deckDealtAt: turnedAt,
            deckFace: selected.src,
            deckFaceId: selected.id,
            deckTravelX: 0,
            deckTravelY: 0,
          }),
    },
    props: { ...props, altText: name, assetId: asset.id },
  });
  return response;
}

function drawDeck(drawing: Drawing, storage: Decks, resolve: ResolvePackage, command: DeckDeal) {
  const { deck, id, language, page } = command;
  const state = stackState(storage, deck);
  if (!state) return null;
  const previous = priorDeal(drawing, storage, resolve, state, deck, id);
  if (previous) return previous;
  const { reservation } = state;
  const live = reservation !== undefined && reservation.until > Date.now();
  const reserved = reservation?.id === id && reservation.page === page;
  if ((live && !reserved) || (command.prepared && !reserved) || state.closed?.includes(id))
    return null;
  const game = playableDeck(drawing, resolve, state, deck, page);
  if (!game) return null;
  const { stack, placement, manifest } = game;
  const remaining =
    state.remaining.length === 0 ? shuffledCards(manifest.cards.length) : [...state.remaining];
  const selected = remaining.pop()!;
  const card = manifest.cards[selected];
  if (!card) return null;
  const faceDown = command.faceDown === true;
  const { flight } = command;
  if (flight && (!command.precise || faceDown)) return null;
  const name = faceDown
    ? language === "pl"
      ? "Zakryta karta"
      : "Face-down card"
    : card.name[language];
  const { h: stackHeight } = stack.props;
  const widest =
    (Math.max(manifest.backWidth, ...manifest.cards.map(({ width }) => width)) * stackHeight) /
    manifest.cardHeight;
  const grid = command.precise
    ? undefined
    : (state.grids?.[page] ?? establishGrid(command, stackHeight, widest));
  const height = grid?.height ?? stackHeight;
  const destination = grid === undefined ? command.point : dealPoint(drawing, page, grid);
  const rotation = command.precise ? placement.rotation + (flight?.rotation ?? 0) : 0;
  const dx = command.precise && !flight ? 0 : command.origin.x - destination.x;
  const dy = command.precise && !flight ? 0 : command.origin.y - destination.y;
  const travelX = dx * Math.cos(rotation) + dy * Math.sin(rotation);
  const travelY = dy * Math.cos(rotation) - dx * Math.sin(rotation);
  if (!Number.isFinite(travelX) || !Number.isFinite(travelY)) return null;
  const cardId = dealtCardId(deck, id);
  addImage(drawing, {
    height,
    sourceHeight: manifest.cardHeight,
    id: dealtKey(deck, id),
    meta: faceDown
      ? { deckId: deck, deckBack: manifest.back, deckCardId: cardId, deckDown: true }
      : {
          deckId: deck,
          deckBack: manifest.back,
          deckCardId: cardId,
          deckDealtAt: Date.now(),
          deckFace: card.src,
          deckFaceId: card.id,
          deckTravelX: travelX,
          deckTravelY: travelY,
          ...(flight && {
            deckFlightDuration: flight.duration,
            deckFlightRotation: flight.rotation ?? 0,
          }),
        },
    name,
    page,
    point: destination,
    rotation,
    src: faceDown ? manifest.back : card.src,
    width: faceDown ? manifest.backWidth : card.width,
  });
  storage.set(cardKey(cardId), {
    face: { install: state.install, index: selected, originalName: faceDown ? undefined : name },
  });
  drawing.set(stack.id, { ...stack, meta: { ...stack.meta, deckRemaining: remaining.length } });
  const reveal = faceDown
    ? { card: cardId, faceDown: true as const }
    : { card: card.id, name, width: card.width };
  const recent = [...state.recent, { id, reveal }].slice(-RECENT_DRAWS);
  const grids = grid === undefined ? state.grids : { ...state.grids, [page]: grid };
  const closed =
    reservation && reservation.id !== id ? closedPickup(state, reservation.id) : state.closed;
  storage.set(deckKey(deck), {
    ...state,
    closed,
    grids,
    recent,
    remaining,
    reservation: undefined,
  });
  return reveal;
}

export function changeDeck(
  drawing: Drawing,
  storage: Decks,
  resolve: ResolvePackage,
  command: DeckCommand,
) {
  switch (command.action) {
    case "place":
      return placeDeck(drawing, storage, resolve, command);
    case "draw":
      return drawDeck(drawing, storage, resolve, command);
    case "warm":
    case "prepare":
      return prepareDeck(drawing, storage, resolve, command);
    case "cancel":
      return cancelPickup(storage, command);
    case "flip":
      return flipDeck(drawing, storage, resolve, command);
  }
}
