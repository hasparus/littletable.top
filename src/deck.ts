import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import { AssetRecordType, idValidator, pageIdValidator } from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { T } from "@tldraw/validate";

import type { InstalledGizmo } from "./gizmo-packages";

import { type DeckReveal, deckStack } from "./deck-records";
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
  grids?: Partial<Record<TLPageId, FixedDeckGrid>>;
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
  grid: deckGrid.optional(),
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
  const deckId = deckImageId(id);
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

type BoardPiece = Extract<TLRecord, { typeName: "shape" }>;

function pagePlacement(drawing: Drawing, piece: BoardPiece, page: TLPageId) {
  let { x, y, rotation } = piece;
  let parent = drawing.get(piece.parentId);
  const seen = new Set<TLRecord["id"]>();
  while (parent?.typeName === "shape" && !seen.has(parent.id)) {
    seen.add(parent.id);
    const cos = Math.cos(parent.rotation);
    const sin = Math.sin(parent.rotation);
    [x, y] = [parent.x + x * cos - y * sin, parent.y + x * sin + y * cos];
    rotation += parent.rotation;
    parent = drawing.get(parent.parentId);
  }
  return parent?.id === page ? { x, y, rotation } : null;
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
    pagePlacement(drawing, stack, page) === null
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
  const { h: stackHeight } = stack.props;
  const widest =
    (Math.max(...manifest.cards.map(({ width }) => width)) * stackHeight) / manifest.cardHeight;
  const grid = command.precise
    ? undefined
    : (state.grids?.[page] ?? establishGrid(command, stackHeight, widest));
  const height = grid?.height ?? stackHeight;
  const destination = grid === undefined ? command.point : dealPoint(drawing, page, grid);
  addImage(drawing, {
    height,
    sourceHeight: manifest.cardHeight,
    id: dealtKey(deck, id),
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
  const grids = grid === undefined ? state.grids : { ...state.grids, [page]: grid };
  storage.set(deckKey(deck), { ...state, grids, recent, remaining });
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
