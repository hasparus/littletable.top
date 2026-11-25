import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type Editor, reactor } from "tldraw";

import type { PassKeeper } from "./bootstrap";

import { canSummon, type SummonRequest, type SummonView } from "../../src/summon";

type IncomingSummons = {
  editor: Editor | null;
  queued?: SummonView;
  cancel?: () => void;
};

function applySummon(editor: Editor, { page, x, y, zoom }: SummonView) {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const pending = reactor("apply summon when ready", () => {
    // WARNING: tldraw may batch the page record until the next frame after the summon arrives.
    if (editor.getPage(page) === undefined) {
      expiry ??= setTimeout(stop, 5000);
      return;
    }
    clearTimeout(expiry);
    expiry = undefined;
    // WARNING: Changing the camera dispatches a pointer move. Let the active gesture finish first.
    if (editor.inputs.getIsPointing() || editor.inputs.getIsPinching()) return;
    stop();
    if (editor.getCurrentPageId() !== page) {
      editor.markHistoryStoppingPoint("change-page");
      editor.setCurrentPage(page);
    }
    const { width, height } = editor.getViewportScreenBounds();
    editor.setCamera({ x: width / (2 * zoom) - x, y: height / (2 * zoom) - y, z: zoom });
  });
  function stop() {
    clearTimeout(expiry);
    pending.stop();
  }
  pending.start();
  return stop;
}

async function sendSummon(editor: Editor, keeper: PassKeeper, target: string) {
  const { x, y } = editor.getViewportPageBounds().center;
  const view: SummonRequest = {
    page: editor.getCurrentPageId(),
    target,
    x,
    y,
    zoom: editor.getZoomLevel(),
  };
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

  const allowed = canSummon(keeper.bootstrap.person);
  const summon = useMemo(
    () =>
      editor !== null && !keeper.secret && allowed
        ? (target: string) => sendSummon(editor, keeper, target)
        : undefined,
    [allowed, editor, keeper],
  );

  return { receiveSummon, summon };
}
