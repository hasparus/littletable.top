import type { Editor } from "tldraw";

import { useEffect, useState } from "react";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";
import type { DeckActions } from "./deck";

import { GizmoDrawer } from "./gizmo-drawer";
import { installGizmo, roomGizmos } from "./gizmo-library";
import { useGizmoUi } from "./gizmo-ui";

export function BoardGizmoGallery({
  editor,
  online,
  deck,
  keeper,
}: {
  editor: Editor;
  online: boolean;
  deck: DeckActions;
  keeper: PassKeeper;
}) {
  const { copy } = useGizmoUi();
  const [pieces, setPieces] = useState<InstalledGizmo[]>([]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    void roomGizmos(keeper, request.signal).then(
      (items) => {
        if (!request.signal.aborted) {
          setPieces(items);
          setReady(true);
        }
      },
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [keeper]);
  async function install(url: string) {
    const installed = await installGizmo(keeper, url);
    setPieces((previous) => [...previous.filter((item) => item.url !== installed.url), installed]);
  }
  return (
    <GizmoDrawer
      editor={editor}
      online={online}
      deck={deck}
      pieces={pieces}
      status={failed ? copy.gizmoLoadFailed : ready ? "" : copy.loading}
      install={ready ? install : undefined}
    />
  );
}
