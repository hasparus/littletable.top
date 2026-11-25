import { useEffect } from "react";
import { type Editor, react, type TLPageId, useEditor, useToasts, useValue } from "tldraw";

import { type Copy, fill } from "./copy";

/**
 * Pages are tldraw's own records, so the page menu, sync and undo are
 * tldraw's; the board only says where each page's places and people are,
 * and only once there is more than one page to tell apart.
 */
export function usePageNames(editor: Editor | null): Map<TLPageId, string> | null {
  return useValue(
    "page names",
    () => {
      const pages = editor?.getPages() ?? [];
      return pages.length > 1 ? new Map(pages.map((page) => [page.id, page.name])) : null;
    },
    [editor],
  );
}

// WARNING: Keep the current page in the tab's storage, because a new visitor following the same share link should start on the first page.
function rememberPage(editor: Editor, board: string): () => void {
  const key = `board:${board}:page`;
  try {
    const kept = sessionStorage.getItem(key) as TLPageId | null;
    if (kept !== null && kept !== editor.getCurrentPageId() && editor.getPage(kept) !== undefined) {
      editor.setCurrentPage(kept);
    }
  } catch {
    // WARNING: A browser can block sessionStorage. Keep the editor on its initial page when the read fails.
  }
  return react("remember page", () => {
    const page = editor.getCurrentPageId();
    try {
      sessionStorage.setItem(key, page);
    } catch {
      // WARNING: A browser can block sessionStorage. A failed write must not interrupt navigation.
    }
  });
}

function noticeDeletedPage(editor: Editor, say: (gone: string, page: string) => void): () => void {
  let gone: string | null = null;
  const before = editor.sideEffects.registerBeforeDeleteHandler("page", (page, source) => {
    if (source === "remote" && page.id === editor.getCurrentPageId()) gone = page.name;
  });
  const after = editor.sideEffects.registerAfterDeleteHandler("page", () => {
    if (gone === null) return;
    say(gone, editor.getCurrentPage().name);
    gone = null;
  });
  return () => {
    before();
    after();
  };
}

export function PageKeeper({ board, copy }: { board: string; copy: Copy }) {
  const editor = useEditor();
  const { addToast } = useToasts();
  useEffect(() => rememberPage(editor, board), [board, editor]);
  useEffect(
    () =>
      noticeDeletedPage(editor, (gone, page) =>
        addToast({ severity: "info", title: fill(copy.pageDeleted, { gone, page }) }),
      ),
    [addToast, copy, editor],
  );
  return null;
}
