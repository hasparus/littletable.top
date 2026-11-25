import type { Editor, VecModel } from "tldraw";

import { createContext, useRef, useState } from "react";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";

import { changeDeck, dealtCardId, type DeckCommand, type DeckState } from "../../src/deck";
import {
  deckCancelled,
  deckDropped,
  deckPlaced,
  deckPrepared,
  deckRevealed,
  type DeckReveal,
} from "../../src/deck-records";
import { playGizmoCue } from "./gizmo-feedback";

type DeckResponse = ReturnType<typeof changeDeck>;
type Transport = (
  editor: Editor,
  command: DeckCommand,
  installed?: InstalledGizmo,
) => Promise<DeckResponse>;

type Deal = Extract<DeckCommand, { action: "draw" }>;
type CardGrip = { lift: number; tilt: number; x: number; y: number };
export type DeckDrop = { at: number; card: Deal["deck"]; grip: CardGrip };
export type DeckPickup = { id: string; cancel: () => void; image: HTMLImageElement | null };

type DealOptions = {
  pickup?: DeckPickup;
  faceDown?: boolean;
  flight?: Deal["flight"];
  grid?: Deal["grid"];
  release?: { at: number; grip: CardGrip; track: (drop: DeckDrop) => void };
};

export function preloadDeckFace(src: string) {
  const image = new Image();
  image.fetchPriority = "high";
  image.decoding = "async";
  image.src = src;
  void image.decode().catch(() => null);
  return image;
}

function useDeckActions(canDeal: boolean, send: Transport) {
  const pending = useRef(false);
  const requests = useRef<Promise<unknown> | null>(null);
  const lastDrop = useRef<DeckDrop | null>(null);
  const previousPlacement = useRef<{ id: string; key: string } | null>(null);
  const [drawing, setDrawing] = useState<string | null>(null);
  const [failedDeck, setFailedDeck] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<DeckReveal | null>(null);

  async function place(editor: Editor, point: VecModel, installed: InstalledGizmo) {
    if (!canDeal || pending.current || editor.getIsReadonly() || installed.manifest.kind !== "deck")
      return false;
    const page = editor.getCurrentPageId();
    const key = `${installed.url}:${page}:${point.x}:${point.y}`;
    const id =
      previousPlacement.current?.key === key ? previousPlacement.current.id : crypto.randomUUID();
    previousPlacement.current = { id, key };
    pending.current = true;
    const result = await send(
      editor,
      {
        action: "place",
        height: Math.max(1, Math.min(40_000, installed.manifest.height / editor.getZoomLevel())),
        id,
        install: installed.url,
        language: editor.user.getLocale() === "pl" ? "pl" : "en",
        page,
        point: { x: point.x, y: point.y },
      },
      installed,
    ).catch(() => null);
    pending.current = false;
    if (result === null || !("deck" in result)) return false;
    previousPlacement.current = null;
    return true;
  }

  function sendGesture(editor: Editor, command: DeckCommand) {
    return send(editor, command)
      .catch(() => send(editor, command))
      .catch(() => null);
  }

  function enqueue<T>(run: () => Promise<T>) {
    const next = (requests.current ?? Promise.resolve()).then(run, run);
    requests.current = next;
    return next;
  }

  async function topFace(editor: Editor, deck: Deal["deck"]) {
    if (!canDeal || editor.getIsReadonly()) return null;
    const result = await send(editor, {
      action: "warm",
      deck,
      page: editor.getCurrentPageId(),
    }).catch(() => null);
    return result && "face" in result ? result.face : null;
  }

  function prepare(editor: Editor, deck: Deal["deck"], warmed: HTMLImageElement | null) {
    const id = crypto.randomUUID();
    const page = editor.getCurrentPageId();
    let cancelled = false;
    let requested = false;
    const pickup: DeckPickup = {
      id,
      image: null,
      cancel() {
        if (cancelled) return;
        cancelled = true;
        pickup.image = null;
        if (requested)
          void enqueue(() => send(editor, { action: "cancel", deck, id, page }).catch(() => null));
      },
    };
    void enqueue(async () => {
      if (!canDeal || cancelled || editor.getIsReadonly() || editor.getCurrentPageId() !== page)
        return;
      requested = true;
      const command: DeckCommand = {
        action: "prepare",
        deck,
        id,
        page,
        language: editor.user.getLocale() === "pl" ? "pl" : "en",
      };
      const result = await sendGesture(editor, command);
      if (!result || !("face" in result) || cancelled) return;
      pickup.image =
        warmed?.src === new URL(result.face, document.baseURI).href &&
        (!warmed.complete || warmed.naturalWidth > 0)
          ? warmed
          : preloadDeckFace(result.face);
    });
    return pickup;
  }

  function draw(
    editor: Editor,
    deck: Deal["deck"],
    point: VecModel,
    origin: VecModel,
    options: DealOptions,
  ) {
    const page = editor.getCurrentPageId();
    const run = async () => {
      if (
        !canDeal ||
        pending.current ||
        editor.getIsReadonly() ||
        editor.getCurrentPageId() !== page
      )
        return false;
      const id = options.pickup?.id ?? crypto.randomUUID();
      if (options.release) {
        const drop = {
          at: options.release.at,
          grip: options.release.grip,
          card: dealtCardId(deck, id),
        };
        lastDrop.current = drop;
        options.release.track(drop);
      }
      pending.current = true;
      setDrawing(deck);
      setFailedDeck(null);
      setRevealed(null);
      const command: Deal = {
        action: "draw",
        deck,
        id,
        language: editor.user.getLocale() === "pl" ? "pl" : "en",
        origin: { x: origin.x, y: origin.y },
        page,
        point: { x: point.x, y: point.y },
        precise: !!options.release,
        ...(options.grid && { grid: options.grid }),
        ...(options.flight && { flight: options.flight }),
        ...(options.faceDown && { faceDown: true }),
        ...(options.pickup && { prepared: true }),
      };
      const result = await sendGesture(editor, command);
      pending.current = false;
      setDrawing(null);
      if (result === null || !("card" in result)) {
        setFailedDeck(deck);
        return false;
      }
      playGizmoCue("deal");
      if ("name" in result) setRevealed(result);
      return true;
    };
    return enqueue(run).then((ok) => {
      if (!ok) options.pickup?.cancel();
      return ok;
    });
  }

  async function flip(editor: Editor, card: Deal["deck"], faceDown = false) {
    if (editor.getIsReadonly() || editor["isShapeOrAncestorLocked"](card)) return false;
    const result = await sendGesture(editor, {
      action: "flip",
      ...(faceDown && { faceDown: true }),
      card,
      page: editor.getCurrentPageId(),
      language: editor.user.getLocale() === "pl" ? "pl" : "en",
    });
    if (!result || !("card" in result)) return false;
    playGizmoCue("deal");
    setRevealed("name" in result ? result : null);
    return true;
  }

  return { canDeal, draw, drawing, failedDeck, flip, lastDrop, place, prepare, revealed, topFace };
}

export function useBoardDeck(keeper: PassKeeper, canDeal: boolean) {
  return useDeckActions(canDeal, async (_, command) => {
    const response = await fetch(`${keeper.room}/deck`, {
      body: JSON.stringify(command),
      headers: {
        Authorization: `Bearer ${await keeper.pass()}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (response.status === 403) {
      keeper.end("link-reset");
      return null;
    }
    if (response.status === 409) return null;
    if (!response.ok) throw new Error(`status ${response.status}`);
    const result: unknown = await response.json();
    if (
      deckPlaced.isValid(result) ||
      deckRevealed.isValid(result) ||
      deckPrepared.isValid(result) ||
      deckCancelled.isValid(result) ||
      deckDropped.isValid(result)
    )
      return result;
    throw new Error("Invalid deck result");
  });
}

export function useLocalDeck() {
  const decks = useRef(new Map<string, DeckState>());
  const packages = useRef(new Map<string, InstalledGizmo>());
  return useDeckActions(true, async (editor, command, installed) => {
    if (installed !== undefined) packages.current.set(installed.url, installed);
    let result: ReturnType<typeof changeDeck> = null;
    editor.run(
      () => {
        const { store } = editor;
        result = changeDeck(
          {
            get: (id) => store.get(id),
            set: (_, record) => store.put([record]),
            values: () => store.allRecords(),
          },
          decks.current,
          (url) => packages.current.get(url) ?? null,
          command,
        );
      },
      { history: "ignore" },
    );
    return result;
  });
}

export type DeckActions = ReturnType<typeof useBoardDeck>;

export const DeckContext = createContext<DeckActions | undefined>(undefined);
