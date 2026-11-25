import type { Editor, VecModel } from "tldraw";

import { createContext, useRef, useState } from "react";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";

import { changeDeck, type DeckCommand, type DeckState } from "../../src/deck";
import { deckPlaced, deckRevealed, type DeckReveal } from "../../src/deck-records";
import { playGizmoCue } from "./gizmo-feedback";

type DeckResponse = { deck: string } | DeckReveal | null;
type Transport = (
  editor: Editor,
  command: DeckCommand,
  installed?: InstalledGizmo,
) => Promise<DeckResponse>;

function useDeckActions(send: Transport) {
  const pending = useRef(false);
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

  async function draw(
    editor: Editor,
    deck: Extract<DeckCommand, { action: "draw" }>["deck"],
    point: VecModel,
    origin: VecModel,
    precise: boolean,
  ) {
    if (pending.current || editor.getIsReadonly()) return;
    const id = previousDraws.current.get(deck) ?? crypto.randomUUID();
    previousDraws.current.set(deck, id);
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
      page: editor.getCurrentPageId(),
      point: { x: point.x, y: point.y },
      precise,
    }).catch(() => null);
    pending.current = false;
    setDrawing(null);
    if (result === null || !("card" in result)) {
      setFailedDeck(deck);
      return;
    }
    previousDraws.current.delete(deck);
    playGizmoCue("deal");
    setRevealed(result);
  }

  return { draw, drawing, failedDeck, place, revealed };
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
