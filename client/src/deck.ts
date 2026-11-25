import type { Editor, VecModel } from "tldraw";

import { createContext, useRef, useState } from "react";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";

import { changeDeck, dealtCardId, type DeckCommand, type DeckState } from "../../src/deck";
import { deckPlaced, deckRevealed, type DeckReveal } from "../../src/deck-records";
import { playGizmoCue } from "./gizmo-feedback";

type DeckResponse = { deck: string } | DeckReveal | null;
type Transport = (
  editor: Editor,
  command: DeckCommand,
  installed?: InstalledGizmo,
) => Promise<DeckResponse>;

type Deal = Extract<DeckCommand, { action: "draw" }>;
export type DeckDrop = { at: number; card: Deal["deck"] };
type DealOptions = {
  grid?: Deal["grid"];
  release?: { at: number; track: (drop: DeckDrop) => void };
};

function useDeckActions(send: Transport) {
  const pending = useRef(false);
  const requests = useRef<Promise<boolean> | null>(null);
  const lastDrop = useRef<DeckDrop | null>(null);
  const previousPlacement = useRef<{ id: string; key: string } | null>(null);
  const previousDraws = useRef(new Map<string, string>());
  const [drawing, setDrawing] = useState<string | null>(null);
  const [failedDeck, setFailedDeck] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<DeckReveal | null>(null);

  async function place(editor: Editor, point: VecModel, installed: InstalledGizmo) {
    if (pending.current || editor.getIsReadonly() || installed.manifest.kind !== "deck")
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

  function draw(
    editor: Editor,
    deck: Deal["deck"],
    point: VecModel,
    origin: VecModel,
    options: DealOptions,
  ) {
    const page = editor.getCurrentPageId();
    const run = async () => {
      if (pending.current || editor.getIsReadonly() || editor.getCurrentPageId() !== page)
        return false;
      const id = previousDraws.current.get(deck) ?? crypto.randomUUID();
      previousDraws.current.set(deck, id);
      if (options.release) {
        const drop = { at: options.release.at, card: dealtCardId(deck, id) };
        lastDrop.current = drop;
        options.release.track(drop);
      }
      pending.current = true;
      setDrawing(deck);
      setFailedDeck(null);
      setRevealed(null);
      const result = await send(editor, {
        action: "draw",
        deck,
        id,
        language: editor.user.getLocale() === "pl" ? "pl" : "en",
        origin: { x: origin.x, y: origin.y },
        page,
        point: { x: point.x, y: point.y },
        precise: !!options.release,
        ...(options.grid && { grid: options.grid }),
      }).catch(() => null);
      pending.current = false;
      setDrawing(null);
      if (result === null || !("card" in result)) {
        setFailedDeck(deck);
        return false;
      }
      previousDraws.current.delete(deck);
      playGizmoCue("deal");
      setRevealed(result);
      return true;
    };
    requests.current = requests.current ? requests.current.then(run, run) : run();
    return requests.current;
  }

  return { draw, drawing, failedDeck, lastDrop, place, revealed };
}

export function useBoardDeck(keeper: PassKeeper) {
  return useDeckActions(async (_, command) => {
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
    if (!response.ok) throw new Error(`status ${response.status}`);
    const result: unknown = await response.json();
    if (deckPlaced.isValid(result) || deckRevealed.isValid(result)) return result;
    throw new Error("Invalid deck result");
  });
}

export function useLocalDeck() {
  const decks = useRef(new Map<string, DeckState>());
  const packages = useRef(new Map<string, InstalledGizmo>());
  return useDeckActions(async (editor, command, installed) => {
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
