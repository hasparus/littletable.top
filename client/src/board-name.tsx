import { createContext, type ReactNode, useContext, useState } from "react";
import {
  TldrawUiDialogFooter,
  TldrawUiDialogHeader,
  TldrawUiDialogTitle,
  TldrawUiMenuItem,
  useDialogs,
} from "tldraw";

import type { PassKeeper } from "./bootstrap";

import { MAX_TITLE_LENGTH } from "../../src/limits";
import { cleanTitle } from "../../src/names";
import { useBoardUi } from "./ui";

type BoardName = { rename: (title: string) => Promise<void>; title: string };

const BoardNameContext = createContext<BoardName | null>(null);

export function BoardNameProvider({
  children,
  keeper,
}: {
  children: ReactNode;
  keeper: PassKeeper;
}) {
  const [title, setTitle] = useState(keeper.bootstrap.title);
  const { board, publication } = keeper.bootstrap;

  async function rename(name: string) {
    if (!publication) throw new Error("Rename unavailable");
    const response = await fetch(`/api/boards/${encodeURIComponent(board)}/rename`, {
      body: JSON.stringify({ title: name }),
      headers: { "Content-Type": "application/json", "X-CSRF-Token": publication.csrf },
      method: "POST",
    });
    if (!response.ok) throw new Error("Rename failed");
    const result: { title: string } = await response.json();
    setTitle(result.title);
    document.title = result.title;
  }

  return (
    <BoardNameContext.Provider value={publication ? { rename, title } : null}>
      {children}
    </BoardNameContext.Provider>
  );
}

export const useBoardName = () => useContext(BoardNameContext);

function RenameDialog({ onClose }: { onClose: () => void }) {
  const board = useBoardName();
  const { copy } = useBoardUi();
  const [draft, setDraft] = useState(board?.title ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const cleaned = cleanTitle(draft);

  async function submit() {
    if (!board || !cleaned || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await board.rename(cleaned);
      onClose();
    } catch {
      setFailed(true);
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TldrawUiDialogHeader>
        <TldrawUiDialogTitle>{copy.renameBoard}</TldrawUiDialogTitle>
      </TldrawUiDialogHeader>
      <label className="mx-4 my-2 flex flex-col gap-1 text-sm">
        {copy.boardName}
        <input
          className="h-11 rounded-lg border border-border bg-bg-secondary px-3 text-base"
          disabled={saving}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value);
            setFailed(false);
          }}
          onFocus={(event) => event.target.select()}
          required
          value={draft}
        />
      </label>
      {failed && (
        <p className="px-4 text-sm text-danger-text" role="alert">
          {copy.renameFailed}
        </p>
      )}
      <TldrawUiDialogFooter>
        <button className="btn btn-secondary" disabled={saving} onClick={onClose} type="button">
          {copy.cancel}
        </button>
        <button className="btn btn-primary" disabled={saving || !cleaned} type="submit">
          {copy.save}
        </button>
      </TldrawUiDialogFooter>
    </form>
  );
}

export function RenameBoardItem() {
  const board = useBoardName();
  const { copy } = useBoardUi();
  const { addDialog } = useDialogs();
  if (!board) return null;
  return (
    <TldrawUiMenuItem
      id="rename-board"
      label={copy.renameBoard}
      onSelect={() => addDialog({ component: RenameDialog })}
    />
  );
}
