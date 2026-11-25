import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import type { PassKeeper } from "./bootstrap";

import {
  type DeckManifest,
  gizmoSource,
  type InstalledGizmo,
  isGizmoAssetUrl,
} from "../../src/gizmo-packages";
import { roomGizmos } from "./gizmo-library";

type Lookup = {
  get(url: string): InstalledGizmo | undefined;
  getDeck(back: string): DeckManifest | undefined;
  load(url: string): void;
  loadDeck(back: string): void;
  subscribe(fn: () => void): () => void;
};
const noop: () => void = () => false;
const missing = new Map<string, InstalledGizmo>();
const empty: Lookup = {
  get: (url) => missing.get(url),
  getDeck: (back) => installedDeck(missing.values(), back),
  load: noop,
  loadDeck: noop,
  subscribe: () => noop,
};
const Context = createContext(empty);

function installedDeck(pieces: Iterable<InstalledGizmo>, back: string) {
  for (const { manifest } of pieces) {
    if (manifest.kind === "deck" && manifest.back === back) return manifest;
  }
}

function boardLookup(keeper: PassKeeper) {
  let known = new Map<string, InstalledGizmo>();
  const listeners = new Set<() => void>();
  let loading: Map<string, () => boolean> | undefined;
  const queued = new Map<string, () => boolean>();

  function read(batch: Map<string, () => boolean>) {
    loading = batch;
    void roomGizmos(keeper, AbortSignal.timeout(12_000))
      .then((pieces) => {
        known = new Map(pieces.map((piece) => [piece.url, piece]));
        for (const listener of listeners) listener();
      }, noop)
      .finally(() => {
        loading = undefined;
        const followUp = new Map([...queued].filter(([, found]) => !found()));
        queued.clear();
        if (followUp.size > 0) read(followUp);
      });
  }

  function refresh(key: string, found: () => boolean) {
    if (found() || loading?.has(key)) return;
    if (loading) queued.set(key, found);
    else read(new Map([[key, found]]));
  }

  function getDeck(back: string) {
    return installedDeck(known.values(), back);
  }

  return {
    get: (url: string) => known.get(url),
    getDeck,
    load(url: string) {
      if (gizmoSource(url)) refresh(url, () => known.has(url));
    },
    loadDeck(back: string) {
      if (back.startsWith(`${keeper.room}/gizmo-assets/`) && isGizmoAssetUrl(back)) {
        refresh(back, () => getDeck(back) !== undefined);
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function BoardInstallations({
  keeper,
  children,
}: {
  keeper: PassKeeper;
  children: ReactNode;
}) {
  const lookup = useMemo(() => boardLookup(keeper), [keeper]);
  return <Context.Provider value={lookup}>{children}</Context.Provider>;
}

export function PracticeInstallations({
  pieces,
  children,
}: {
  pieces: InstalledGizmo[];
  children: ReactNode;
}) {
  const lookup = useMemo(
    () => ({
      ...empty,
      get: (url: string) => pieces.find((piece) => piece.url === url),
      getDeck: (back: string) => installedDeck(pieces, back),
    }),
    [pieces],
  );
  return <Context.Provider value={lookup}>{children}</Context.Provider>;
}

export function useInstalledGizmo(url: string) {
  const lookup = useContext(Context);
  const piece = useSyncExternalStore(lookup.subscribe, () => lookup.get(url));
  useEffect(() => {
    if (piece) return;
    const refresh = () => lookup.load(url);
    refresh();
    globalThis.addEventListener("online", refresh);
    return () => globalThis.removeEventListener("online", refresh);
  }, [lookup, piece, url]);
  return piece;
}

export function useInstalledDeck(back: string) {
  const lookup = useContext(Context);
  const deck = useSyncExternalStore(lookup.subscribe, () => lookup.getDeck(back));
  useEffect(() => {
    if (deck) return;
    const refresh = () => lookup.loadDeck(back);
    refresh();
    globalThis.addEventListener("online", refresh);
    return () => globalThis.removeEventListener("online", refresh);
  }, [back, deck, lookup]);
  return deck;
}
