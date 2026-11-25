import { useEffect, useRef } from "react";

import { type DeckManifest, isGizmoAssetUrl } from "../../src/gizmo-packages";
import { useInstalledDeck } from "./gizmo-installed";

type Job = { users: number; cancel?: () => void };
type ActiveDeck = { users: number; release: () => void };

const MAX_ACTIVE = 2;
const MAX_REMEMBERED = 4096;
const work = new Map<string, Job>();
const warmed = new Set<string>();
const decks = new Map<string, ActiveDeck>();
let active = 0;
let scheduled = false;

function remember(src: string) {
  warmed.add(src);
  if (warmed.size > MAX_REMEMBERED) warmed.delete(warmed.values().next().value!);
}

function schedule() {
  if (scheduled || active >= MAX_ACTIVE || work.size === active) return;
  scheduled = true;
  if ("requestIdleCallback" in globalThis) requestIdleCallback(pump, { timeout: 750 });
  else setTimeout(pump, 0);
}

function start(src: string, job: Job) {
  active++;
  const image = new Image();
  image.fetchPriority = "low";
  image.decoding = "async";
  function finish(ok: boolean) {
    if (work.get(src) !== job) return;
    delete job.cancel;
    if (ok) remember(src);
    work.delete(src);
    active--;
    schedule();
  }
  job.cancel = () => {
    finish(false);
    image.removeAttribute("src");
  };
  image.src = src;
  void image.decode().then(
    () => finish(true),
    () => finish(false),
  );
}

function pump() {
  scheduled = false;
  for (const [src, job] of work) {
    if (active === MAX_ACTIVE) return;
    if (!job.cancel) start(src, job);
  }
}

function queue(deck: DeckManifest) {
  const urls = new Set([deck.back, ...deck.cards.map(({ src }) => src)].filter(isGizmoAssetUrl));
  const leases = new Map<string, Job>();
  for (const src of urls) {
    if (warmed.has(src)) continue;
    const job = work.get(src) ?? { users: 0 };
    job.users++;
    work.set(src, job);
    leases.set(src, job);
  }
  schedule();
  return () => {
    for (const [src, job] of leases) {
      if (work.get(src) !== job) continue;
      job.users--;
      if (job.users > 0) continue;
      if (job.cancel) job.cancel();
      else work.delete(src);
    }
  };
}

function retainDeck(deck: DeckManifest) {
  const activeDeck = decks.get(deck.back) ?? { users: 0, release: queue(deck) };
  activeDeck.users++;
  decks.set(deck.back, activeDeck);
  return () => {
    activeDeck.users--;
    if (activeDeck.users > 0) return;
    activeDeck.release();
    decks.delete(deck.back);
  };
}

function preloadWhileVisible(node: HTMLElement, deck: DeckManifest) {
  let intersects = !("IntersectionObserver" in globalThis);
  let release: (() => void) | undefined;
  function refresh() {
    if (intersects && !document.hidden) {
      release ??= retainDeck(deck);
    } else {
      release?.();
      release = undefined;
    }
  }
  const observer = intersects
    ? null
    : new IntersectionObserver(([entry]) => {
        intersects = entry?.isIntersecting === true;
        refresh();
      });
  const stack = node.closest("[data-deck-stack]");
  if (stack) observer?.observe(stack);
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", refresh);
    release?.();
  };
}

export function usePreloadDeckArt(back: string) {
  const marker = useRef<HTMLSpanElement>(null);
  const deck = useInstalledDeck(back);
  useEffect(() => {
    if (!deck || !marker.current) return;
    return preloadWhileVisible(marker.current, deck);
  }, [deck]);
  return marker;
}
