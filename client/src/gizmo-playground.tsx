/* oxlint-disable anti-slop/no-shape-in-symbol-names -- tldraw registers its ShapeUtil extensions via the shapeUtils prop. */
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Editor, Tldraw } from "tldraw";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { Language } from "../settings";

import "./board.css";
import "./gizmo-playground.css";
import registry from "../../gizmos/registry.json";
import { BoardLoading } from "./board-loading";
import { COPY } from "./copy";
import { DeckContext, useLocalDeck } from "./deck";
import { DeckAnnouncement } from "./deck-announcement";
import { DeckImageUtil } from "./deck-piece";
import { GizmoDrawer } from "./gizmo-drawer";
import { GizmoGeoUtil, placeGizmoGeo } from "./gizmo-geo";
import { PracticeInstallations } from "./gizmo-installed";
import { loadPracticeGizmo } from "./gizmo-library";
import { GizmoPracticeContext } from "./gizmo-ui";
import { PANEL_ID } from "./ui";

const assetUrls = getAssetUrlsByImport();
const utils = [GizmoGeoUtil, DeckImageUtil];
const person = { id: "practice:ash", name: "Ash", owner: true };
const seats = [person.name, "Rowan"];

function PracticeTable({
  locale,
  licenseKey,
  pieces: initialPieces,
  focused,
}: {
  locale: Language;
  licenseKey: string;
  pieces: InstalledGizmo[];
  focused: boolean;
}) {
  const [pieces, setPieces] = useState(initialPieces);
  const copy = COPY[locale];
  const deck = useLocalDeck();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [open, setOpen] = useState(
    () =>
      initialPieces.length === 0 ||
      (!focused && matchMedia("(min-width: 760px) and (min-height: 600px)").matches),
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const title = locale === "pl" ? "Stół próbny" : "Practice table";

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  function start(mounted: Editor) {
    mounted.user.updateUserPreferences({ locale });
    setEditor(mounted);
    const { x, y, w, h } = mounted.getViewportScreenBounds();
    const left = open ? 344 : 0;
    const width = w - left;
    const centerX = x + left + width / 2;
    const centerY = y + h * 0.52;
    const spread = Math.max(70, Math.min(158, width * 0.21));
    const top = centerY - Math.min(72, h * 0.13);
    const bottom = centerY + Math.min(95, h * 0.26);
    for (const kind of ["button", "tracker", "deck"] as const) {
      const piece = pieces.find(({ manifest }) => manifest.kind === kind);
      if (!piece) continue;
      const point = mounted.screenToPage(
        focused
          ? { x: centerX, y: centerY }
          : kind === "tracker"
            ? { x: centerX, y: bottom }
            : { x: centerX + (kind === "deck" ? -spread : spread), y: top },
      );
      if (kind === "deck") void deck.place(mounted, point, piece);
      else placeGizmoGeo(mounted, point, piece, seats, locale);
    }
    if (focused) {
      const bounds = mounted.getCurrentPageBounds();
      if (bounds) mounted.zoomToBounds(bounds, { inset: 56, targetZoom: 1.65, immediate: true });
    }
    mounted.selectNone();
  }

  return (
    <PracticeInstallations pieces={pieces}>
      <GizmoPracticeContext.Provider value={{ close, copy, locale, person }}>
        <DeckContext.Provider value={deck}>
          <main data-board-layout="" data-board-shell="" data-gizmo-practice="">
            <div data-practice-canvas="">
              <Tldraw
                assetUrls={assetUrls}
                hideUi
                licenseKey={licenseKey || undefined}
                locale={locale}
                onMount={start}
                shapeUtils={utils}
              />
            </div>
            <header data-practice-header="">
              <button
                aria-controls={PANEL_ID.gizmos}
                aria-expanded={open}
                disabled={!editor}
                ref={trigger}
                onClick={() => setOpen(!open)}
                type="button"
              >
                {copy.gizmos}
              </button>
              <h1>{title}</h1>
              <a href="/research/gizmos/">{locale === "pl" ? "Notatki" : "Research notes"}</a>
            </header>
            {editor && open && (
              <GizmoDrawer
                editor={editor}
                online
                seats={seats}
                deck={deck}
                pieces={pieces}
                custom={false}
                marketplace={registry}
                install={async (url) => {
                  const piece = await loadPracticeGizmo(url);
                  setPieces((current) =>
                    current.some((entry) => entry.url === piece.url)
                      ? current
                      : [...current, piece],
                  );
                  return piece;
                }}
              />
            )}
            <DeckAnnouncement name={deck.revealed?.name ?? ""} />
          </main>
        </DeckContext.Provider>
      </GizmoPracticeContext.Provider>
    </PracticeInstallations>
  );
}

export function mountGizmoPlayground(root: HTMLElement, locale: Language, licenseKey: string) {
  document.title = locale === "pl" ? "Stół próbny · Gizmos" : "Practice table · Gizmos";
  const view = createRoot(root);
  const copy = COPY[locale];
  function load() {
    view.render(<BoardLoading text={copy.loading} />);
    const query = new URLSearchParams(location.search);
    const focus = registry.find((entry) =>
      entry.url.endsWith("/gizmos/" + query.get("gizmo") + "/gizmo.json"),
    );
    const shelf = query.has("empty") ? [] : focus ? [focus] : registry;
    void Promise.all(shelf.map((entry) => loadPracticeGizmo(entry.url))).then(
      (pieces) =>
        view.render(
          <PracticeTable
            locale={locale}
            licenseKey={licenseKey}
            pieces={pieces}
            focused={!!focus}
          />,
        ),
      () =>
        view.render(
          <div data-practice-status="" role="alert">
            <p>{copy.gizmoLoadFailed}</p>
            <button type="button" onClick={load}>
              {copy.retry}
            </button>
          </div>,
        ),
    );
  }
  load();
}
