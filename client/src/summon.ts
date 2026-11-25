import type { Editor } from "tldraw";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { SummonView } from "../../src/summon";
import type { PassKeeper } from "./bootstrap";

type IncomingSummons = {
  editor: Editor | null;
  queued?: SummonView;
  cancel?: () => void;
};

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
  const incoming = useRef<IncomingSummons | null>(null);

  useLayoutEffect(() => {
    if (!active || keeper.secret) return;
    incoming.current = { editor: null };
    return () => {
      incoming.current = null;
    };
  }, [active, keeper]);

  useEffect(() => {
    const target = incoming.current;
    if (target === null || editor === null) return;
    target.editor = editor;
    if (target.queued !== undefined) {
      target.cancel = applySummon(editor, target.queued);
      target.queued = undefined;
    }
    return () => {
      target.cancel?.();
      target.cancel = undefined;
      target.editor = null;
    };
  }, [active, editor, keeper]);

  const receiveSummon = useCallback((view: SummonView) => {
    const target = incoming.current;
    if (target === null) return;
    if (target.editor === null) {
      target.queued = view;
      return;
    }
    target.cancel?.();
    target.cancel = applySummon(target.editor, view);
  }, []);

  const { owner } = keeper.bootstrap.person;
  const summon = useMemo(
    () =>
      editor !== null && !keeper.secret && owner ? () => sendSummon(editor, keeper) : undefined,
    [editor, keeper, owner],
  );

  return { receiveSummon, summon };
}
