import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import type { PassKeeper } from "./bootstrap";

import { gizmoSource, type InstalledGizmo } from "../../src/gizmo-packages";
import { roomGizmos } from "./gizmo-library";

type Lookup = {
  get(url: string): InstalledGizmo | undefined;
  load(url: string): void;
  subscribe(fn: () => void): () => void;
};
const noop: () => void = () => false;
const missing = new Map<string, InstalledGizmo>();
const empty: Lookup = { get: (url) => missing.get(url), load: noop, subscribe: () => noop };
const Context = createContext(empty);

function boardLookup(keeper: PassKeeper) {
  let known = new Map<string, InstalledGizmo>();
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  return {
    get: (url: string) => known.get(url),
    load(url: string) {
      if (known.has(url) || pending || !gizmoSource(url)) return;
      pending = roomGizmos(keeper, AbortSignal.timeout(12_000))
        .then((pieces) => {
          known = new Map(pieces.map((piece) => [piece.url, piece]));
          for (const listener of listeners) listener();
        }, noop)
        .finally(() => {
          pending = undefined;
        });
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
    () => ({ ...empty, get: (url: string) => pieces.find((piece) => piece.url === url) }),
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
