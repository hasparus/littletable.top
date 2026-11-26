import type { Editor } from "tldraw";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { GizmoDecision, GizmoRequest, InstalledGizmo } from "../../src/gizmo-packages";
import type { PassKeeper } from "./bootstrap";
import type { DeckActions } from "./deck";

import { GizmoDrawer } from "./gizmo-drawer";
import { changeGizmoRequest, installGizmo, roomGizmoRequests, roomGizmos } from "./gizmo-library";
import { registry } from "./gizmo-registry";
import { GizmoRequestDialog } from "./gizmo-request-dialog";
import { useBoardUi } from "./ui";

function useGizmoInventory(
  keeper: PassKeeper,
  online: boolean,
  owner: boolean,
  shown: boolean,
  revision: number,
) {
  const [pieces, setPieces] = useState<InstalledGizmo[] | null>(null);
  const [entries, setEntries] = useState<GizmoRequest[]>([]);
  const [failed, setFailed] = useState(false);
  const [arrival, setArrival] = useState<string>();
  const [localRevision, setLocalRevision] = useState(0);
  const known = useRef<GizmoRequest[]>([]);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    if (!shown) setArrival(undefined);
  }
  const loadFailed = useEffectEvent(() => setFailed(true));
  const receive = useEffectEvent((items: InstalledGizmo[] | null, requests: GizmoRequest[]) => {
    if (shown && !owner) {
      const pendingIds = new Set(
        known.current.filter((entry) => entry.status === "pending").map((entry) => entry.id),
      );
      const approved = requests.find((entry) => entry.installedUrl && pendingIds.has(entry.id));
      if (approved) setArrival(approved.installedUrl);
    }
    known.current = requests;
    if (items) setPieces(items);
    setEntries(requests);
    setFailed(false);
  });

  useEffect(() => {
    if (!online || (!shown && !owner)) return;
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([
      shown ? roomGizmos(keeper, signal) : null,
      roomGizmoRequests(keeper, signal),
    ]).then(
      ([items, requests]) => {
        if (!signal.aborted) receive(items, requests);
      },
      () => {
        if (!signal.aborted) loadFailed();
      },
    );
    return () => controller.abort();
  }, [keeper, online, owner, localRevision, revision, shown]);

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
    const entry = await changeGizmoRequest(keeper, { url });
    remember(entry);
    return entry.status;
  }
  async function review(id: number, action: GizmoDecision["action"]) {
    const entry = await changeGizmoRequest(keeper, { id, action });
    if (entry.installedUrl && action === "approve") {
      const items = await roomGizmos(keeper, AbortSignal.timeout(15_000));
      setPieces(items);
      setFailed(false);
      setArrival(entry.installedUrl);
    }
    remember(entry);
    return entry;
  }
  return { pieces, entries, failed, arrival, install, request, review };
}

function usePendingRequest(entries: GizmoRequest[], enabled: boolean, shown: boolean) {
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    if (shown) setDismissed(new Set());
  }
  return {
    pending: enabled
      ? entries.find((entry) => entry.status === "pending" && !dismissed.has(entry.id))
      : undefined,
    dismiss: (id: number) => setDismissed((previous) => new Set(previous).add(id)),
  };
}

function requestsWith(entries: GizmoRequest[], status: GizmoRequest["status"]) {
  return entries.flatMap((entry) => (entry.status === status ? [entry.url] : []));
}

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
  const { pieces, entries, failed, arrival, install, request, review } = useGizmoInventory(
    keeper,
    online,
    person.owner,
    shown,
    revision,
  );
  const { pending, dismiss } = usePendingRequest(entries, person.owner && online, shown);
  const actions = person.owner ? { install } : { request };
  const history = person.owner ? [] : entries;
  async function decide(id: number, action: GizmoDecision["action"]) {
    const entry = await review(id, action);
    if (entry.status === "installed") open("gizmos");
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
          declined={requestsWith(history, "declined")}
          requested={requestsWith(history, "pending")}
          {...(pieces && actions)}
        />
      )}
      {pending && (
        <GizmoRequestDialog
          key={pending.id}
          entry={pending}
          onDismiss={() => dismiss(pending.id)}
          onDecision={(action) => decide(pending.id, action)}
        />
      )}
    </>
  );
}
