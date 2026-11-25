import type { Atom, Editor, TLShapeId } from "tldraw";

import { createContext, type Dispatch, type SetStateAction, useContext } from "react";

import type { BoardFiles } from "./assets";
import type { Person } from "./bootstrap";
import type { Copy } from "./copy";
import type { Flash } from "./highlight";
import type { ImageText } from "./image-text";
import type { Rolls } from "./rolls";
import type { BoardSearch } from "./search-board";

/** The search sheet is also where the board's places are listed. */
export type Panel = "chat" | "dice" | "people" | "search";

type RollDraft = { expression: string; pool: number[] };

/**
 * What the board's own controls share: the buttons sit inside tldraw's
 * toolbar and the sheets beside the canvas, so both read it from here.
 */
export type BoardUi = {
  board: string;
  close: (panel: Panel) => void;
  color: string;
  copy: Copy;
  editor: Editor | null;
  files: BoardFiles;
  /** Where the board's menu leads out: their boards, or the board's home for a guest. */
  exit: { href: string; label: string };
  /** What a chosen search result flashes, on this screen only. */
  highlight: Atom<Flash | null>;
  /** The text in the board's images; null until the canvas is up. */
  imageText: ImageText | null;
  locale: string;
  naming: TLShapeId | null;
  /**
   * `typing`: the person asked from the keyboard, so the search field
   * takes focus even on a touch screen.
   */
  open: (panel: Panel | null, options?: { typing: boolean }) => void;
  panel: Panel | null;
  person: Person;
  rollDraft: RollDraft;
  rolls: Rolls;
  search: BoardSearch | null;
  setNaming: (id: TLShapeId | null) => void;
  setRollDraft: Dispatch<SetStateAction<RollDraft>>;
  typing: boolean;
};

export const BoardUiContext = createContext<BoardUi | null>(null);

export function useBoardUi(): BoardUi {
  const ui = useContext(BoardUiContext);
  if (ui === null) throw new Error("board: controls rendered outside the board");
  return ui;
}

export const PANEL_ID: Record<Panel, string> = {
  chat: "board-chat",
  dice: "board-dice",
  people: "board-people",
  search: "board-search",
};
