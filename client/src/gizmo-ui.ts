import { createContext, useContext } from "react";

import { type BoardUi, BoardUiContext } from "./ui";

type GizmoUi = Pick<BoardUi, "copy" | "person" | "locale" | "close">;

export const GizmoPracticeContext = createContext<GizmoUi | null>(null);

export function useGizmoUi() {
  const board = useContext(BoardUiContext);
  const practice = useContext(GizmoPracticeContext);
  const ui = practice ?? board;
  if (ui === null) throw new Error("Gizmos need a table");
  return ui;
}
