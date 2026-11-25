import type { Editor } from "tldraw";

import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

import "./gizmo-drawer.css";

import type { InstalledGizmo } from "../../src/gizmo-packages";
import type { DeckActions } from "./deck";

import {
  gizmoSoundsEnabled,
  setGizmoSoundsEnabled,
  playGizmoCue,
  springGizmo,
} from "./gizmo-feedback";
import { placeGizmoGeo } from "./gizmo-geo";
import { useGizmoUi } from "./gizmo-ui";
import { Icon } from "./icons";
import { usePresent } from "./people";
import { PANEL_ID } from "./ui";

type Piece = InstalledGizmo;
type Point = { x: number; y: number };
type Drag = Point & { piece: Piece; tilt: number };
type Grip = Point & { pointer: number; moved: boolean };
function Miniature({ piece }: { piece: Piece }) {
  const { manifest } = piece;
  if (manifest.kind !== "deck") return <img alt="" draggable={false} src={manifest.preview} />;
  return (
    <span aria-hidden="true" data-gizmo-fan>
      {manifest.cards.slice(0, 3).map((card) => (
        <img alt="" draggable={false} key={card.id} src={card.src} />
      ))}
    </span>
  );
}

function CarriedPiece({ drag }: { drag: Drag }) {
  const miniature = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (miniature.current)
      return springGizmo(miniature.current, (t) => `scale(${1.08 - 0.16 * t})`);
  }, []);
  return (
    <div
      data-gizmo-carry
      aria-hidden="true"
      style={{
        left: drag.x,
        top: drag.y,
        transform: `translate(-50%, -62%) rotate(${drag.tilt}deg)`,
      }}
    >
      <span ref={miniature}>
        <Miniature piece={drag.piece} />
      </span>
    </div>
  );
}

export function GizmoDrawer({
  editor,
  online,
  deck,
  pieces,
  install,
  status,
  seats,
}: {
  seats?: string[];
  editor: Editor;
  online: boolean;
  deck: DeckActions;
  pieces: Piece[];
  install?: (url: string) => Promise<void>;
  status?: string;
}) {
  const { copy, locale, person, close: closePanel } = useGizmoUi();
  const dismiss = useCallback(() => {
    closePanel("gizmos");
    editor
      .getContainer()
      .querySelector<HTMLElement>('[data-testid="main-menu.button"]')
      ?.focus({ preventScroll: true });
  }, [closePanel, editor]);
  const [sounds, setSounds] = useState(gizmoSoundsEnabled);
  const shelf = useRef<HTMLDialogElement>(null);
  const [installFailed, setInstallFailed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const guests = usePresent(editor);
  const grip = useRef<Grip | null>(null);
  const placing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    if (shelf.current)
      return springGizmo(shelf.current, (t) => `translateY(${8 * t}px) scale(${1 - 0.025 * t})`);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      grip.current = null;
      dismiss();
    };
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, [dismiss]);

  async function place(piece: Piece, point: Point) {
    if (placing.current || !online || editor.getIsReadonly()) return;
    placing.current = true;
    setBusy(true);
    setFailed(false);
    const placed =
      piece.manifest.kind === "deck"
        ? await deck.place(editor, point, piece).catch(() => false)
        : placeGizmoGeo(
            editor,
            point,
            piece,
            seats ?? [person.name, ...guests.filter((g) => g.id !== person.id).map((g) => g.name)],
            locale,
          );
    placing.current = false;
    setBusy(false);
    if (placed) {
      playGizmoCue("place");
      if (shelf.current?.isConnected) dismiss();
    } else setFailed(true);
  }

  function grab(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || grip.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    playGizmoCue("pickup");
    grip.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }
  function move(event: PointerEvent<HTMLButtonElement>, piece: Piece) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (!start.moved && Math.hypot(dx, event.clientY - start.y) < 6) return;
    start.moved = true;
    setDrag({
      piece,
      x: event.clientX,
      y: event.clientY,
      tilt: Math.max(-14, Math.min(dx / 9, 14)),
    });
  }
  function release(event: PointerEvent<HTMLButtonElement>, piece: Piece) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    grip.current = null;
    setDrag(null);
    if (!start.moved) {
      void place(piece, editor.getViewportPageBounds().center);
      return;
    }
    const { clientX: x, clientY: y } = event;
    const target = document.elementFromPoint(x, y)?.closest(".tl-canvas");
    if (target && editor.getContainer().contains(target))
      void place(piece, editor.screenToPage({ x, y }));
  }
  function cancel(event: PointerEvent<HTMLButtonElement>) {
    if (grip.current?.pointer !== event.pointerId) return;
    grip.current = null;
    setDrag(null);
  }
  return (
    <>
      <dialog
        open
        ref={shelf}
        data-gizmo-shelf=""
        aria-labelledby="gizmo-title"
        id={PANEL_ID.gizmos}
      >
        <header>
          <h2 id="gizmo-title">{copy.gizmoGallery}</h2>
          <button
            type="button"
            aria-label={copy.gizmoSounds}
            aria-pressed={sounds}
            title={copy.gizmoSounds}
            onClick={() => {
              setGizmoSoundsEnabled(!sounds);
              setSounds(!sounds);
              if (!sounds) playGizmoCue("pickup");
            }}
          >
            <Icon name={sounds ? "SoundOn" : "SoundOff"} />
          </button>
          <button type="button" aria-label={copy.close} onClick={dismiss} ref={close}>
            <Icon name="Close" />
          </button>
        </header>
        {pieces.length > 0 && (
          <div data-gizmo-compartment>
            {pieces.map((piece) => (
              <button
                type="button"
                data-gizmo-piece={piece.manifest.kind}
                data-lifted={drag?.piece === piece || undefined}
                key={piece.url}
                disabled={busy || !online}
                onPointerDown={grab}
                onPointerMove={(e) => move(e, piece)}
                onPointerUp={(e) => release(e, piece)}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
                onClick={(e) => {
                  if (e.detail === 0) void place(piece, editor.getViewportPageBounds().center);
                }}
              >
                <span data-gizmo-display aria-hidden="true">
                  <Miniature piece={piece} />
                </span>
                <span>{piece.manifest.name[locale === "pl" ? "pl" : "en"]}</span>
              </button>
            ))}
          </div>
        )}
        <p role="status">
          {failed
            ? copy.gizmoPlaceFailed
            : status ||
              (online
                ? pieces.length > 0
                  ? copy.gizmoPlace
                  : copy.gizmoEmpty
                : copy.connectionLost)}
        </p>
        {install && (
          <form
            data-gizmo-install
            onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const url = form.querySelector("input")?.value.trim();
              if (!url || installing) return;
              setInstalling(true);
              setInstallFailed(false);
              await install(url).then(
                () => form.reset(),
                () => setInstallFailed(true),
              );
              setInstalling(false);
            }}
          >
            <label htmlFor="gizmo-source">{copy.gizmoSource}</label>
            <input
              id="gizmo-source"
              name="source"
              type="url"
              autoComplete="off"
              spellCheck={false}
              required
              placeholder="https://github.com/…"
            />
            <button type="submit" disabled={installing || !online}>
              {copy.gizmoInstall}
            </button>
            <a href="/research/gizmos/contract.html#install" target="_blank" rel="noreferrer">
              {copy.gizmoBrowse}
            </a>
            {installFailed && <p role="alert">{copy.gizmoInstallFailed}</p>}
          </form>
        )}
      </dialog>
      {drag && <CarriedPiece drag={drag} />}
    </>
  );
}
