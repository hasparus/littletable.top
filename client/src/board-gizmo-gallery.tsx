import type { Editor } from "tldraw";

import { useEffect, useRef, useState } from "react";

import type { GizmoDecision, GizmoRequest, InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";
import type { DeckActions } from "./deck";

import registry from "../../gizmos/registry.json";
import { GizmoDrawer } from "./gizmo-drawer";
import { changeGizmoRequest, installGizmo, roomGizmoRequests, roomGizmos } from "./gizmo-library";
import { GizmoRequestDialog } from "./gizmo-request-dialog";
import { useBoardUi } from "./ui";

export function BoardGizmoGallery({
  editor,
  online,
  deck,
  keeper,
  revision,
}: {
  editor: Editor;
  online: boolean;
  deck: DeckActions;
  keeper: PassKeeper;
  revision: number;
}) {
  const { copy, open, panel, person } = useBoardUi();
  const shown = panel === "gizmos";
  const [pieces, setPieces] = useState<InstalledGizmo[] | null>(null);
  const [entries, setEntries] = useState<GizmoRequest[]>([]);
  const [failed, setFailed] = useState(false);
  const [arrival, setArrival] = useState<string>();
  const [dismissed, setDismissed] = useState<number[]>([]);
  const [localRevision, setLocalRevision] = useState(0);
  const known = useRef<GizmoRequest[]>([]);
  const [previousPanel, setPreviousPanel] = useState(panel);
  if (previousPanel !== panel) {
    setPreviousPanel(panel);
    if (shown) setDismissed([]);
    else setArrival(undefined);
  }

  useEffect(() => {
    if (!online || (!shown && !person.owner)) return;
    const request = new AbortController();
    void Promise.all([
      shown ? roomGizmos(keeper, request.signal) : null,
      roomGizmoRequests(keeper, request.signal),
    ]).then(
      ([items, requests]) => {
        if (request.signal.aborted) return;
        if (shown && !person.owner) {
          const installed = requests.find(
            (entry) =>
              entry.installedUrl &&
              known.current.some((old) => old.id === entry.id && old.status === "pending"),
          );
          if (installed) setArrival(installed.installedUrl);
        }
        known.current = requests;
        if (items) setPieces(items);
        setEntries(requests);
        setFailed(false);
      },
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [keeper, online, person.owner, localRevision, revision, shown]);

  async function install(url: string) {
    const piece = await installGizmo(keeper, url);
    setLocalRevision((value) => value + 1);
    setPieces((previous) => [...(previous ?? []).filter((item) => item.url !== piece.url), piece]);
    return piece;
  }
  function remember(entry: GizmoRequest) {
    setLocalRevision((value) => value + 1);
    known.current = [...known.current.filter((item) => item.id !== entry.id), entry];
    setEntries(known.current);
  }
  async function request(url: string) {
    remember(await changeGizmoRequest(keeper, { url }));
  }
  const pending =
    person.owner && online
      ? entries.find((entry) => entry.status === "pending" && !dismissed.includes(entry.id))
      : undefined;
  async function decide(id: number, action: GizmoDecision["action"]) {
    const entry = await changeGizmoRequest(keeper, { id, action });
    if (entry.installedUrl && action === "approve") {
      const items = await roomGizmos(keeper, AbortSignal.timeout(15_000));
      setPieces(items);
      setFailed(false);
      setArrival(entry.installedUrl);
      open("gizmos");
    }
    remember(entry);
  }
  return (
    <>
      {shown && (
        <GizmoDrawer
          editor={editor}
          online={online}
          deck={deck}
          pieces={pieces ?? []}
          status={failed ? copy.gizmoLoadFailed : pieces === null ? copy.loading : ""}
          marketplace={registry}
          arrival={arrival}
          declined={
            person.owner
              ? []
              : entries.filter((entry) => entry.status === "declined").map((entry) => entry.url)
          }
          requested={
            person.owner
              ? []
              : entries.filter((entry) => entry.status === "pending").map((entry) => entry.url)
          }
          install={person.owner && pieces !== null ? install : undefined}
          request={!person.owner && pieces !== null ? request : undefined}
        />
      )}
      {pending && (
        <GizmoRequestDialog
          key={pending.id}
          entry={pending}
          onDismiss={() => setDismissed((previous) => [...previous, pending.id])}
          onDecision={(action) => decide(pending.id, action)}
        />
      )}
    </>
  );
}
