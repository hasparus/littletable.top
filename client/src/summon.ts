import type { Editor } from "tldraw";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import type { SummonView } from "../../src/summon";
import type { PassKeeper } from "./bootstrap";

function goToSummon(editor: Editor, view: SummonView) {
  const { page, x, y, zoom } = view;
  if (editor.getPage(page) === undefined) return false;
  if (editor.getCurrentPageId() === page) {
    editor.complete();
  } else {
    editor.markHistoryStoppingPoint("change-page");
    editor.setCurrentPage(page);
  }
  const { width, height } = editor.getViewportScreenBounds();
  editor.setCamera({ x: width / (2 * zoom) - x, y: height / (2 * zoom) - y, z: zoom });
  return true;
}

function applySummon(editor: Editor, view: SummonView) {
  if (goToSummon(editor, view)) return;
  // WARNING: tldraw may batch the page record until the next frame after the summon arrives.
  const release = editor.store.listen(
    () => {
      if (goToSummon(editor, view)) stop();
    },
    { scope: "document", source: "remote" },
  );
  const timer = setTimeout(release, 5000);
  function stop() {
    clearTimeout(timer);
    release();
  }
  return stop;
}

async function sendSummon(editor: Editor, keeper: PassKeeper) {
  const { x, y } = editor.getViewportPageBounds().center;
  const view: SummonView = { page: editor.getCurrentPageId(), x, y, zoom: editor.getZoomLevel() };
  try {
    const response = await fetch(`${keeper.room}/summon`, {
      body: JSON.stringify(view),
      headers: {
        Authorization: `Bearer ${await keeper.pass()}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function useSummon(editor: Editor | null, active: boolean, keeper: PassKeeper) {
  const target = useRef<Editor | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    target.current = active && !keeper.secret ? editor : null;
    return () => {
      pending.current?.();
      pending.current = undefined;
      target.current = null;
    };
  }, [active, editor, keeper]);

  const receiveSummon = useCallback((view: SummonView) => {
    if (target.current === null) return;
    pending.current?.();
    pending.current = applySummon(target.current, view);
  }, []);

  const { owner } = keeper.bootstrap.person;
  const summon = useMemo(
    () =>
      editor !== null && !keeper.secret && owner ? () => sendSummon(editor, keeper) : undefined,
    [editor, keeper, owner],
  );

  return { receiveSummon, summon };
}
