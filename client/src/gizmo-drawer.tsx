import type { Editor } from "tldraw";

import {
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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
export type GizmoListing = { url: string; name: { en: string; pl: string }; thumbnail: string };
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

function Marketplace({
  entries,
  installed,
  requested,
  declined,
  installOrRequest,
  canInstall,
  canRequest,
  custom,
  online,
}: {
  entries: readonly GizmoListing[];
  installed: readonly Piece[];
  requested: readonly string[];
  declined: readonly string[];
  installOrRequest: (url: string) => Promise<boolean>;
  canInstall: boolean;
  canRequest: boolean;
  custom: boolean;
  online: boolean;
}) {
  const { copy, locale } = useGizmoUi();
  const [pending, setPending] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const action = canInstall ? copy.gizmoInstall : copy.gizmoRequest;
  const available = online && !pending && (canInstall || canRequest);
  const language = locale === "pl" ? "pl" : "en";

  async function submit(url: string) {
    if (!available) return false;
    setPending(url);
    setMessage(null);
    const succeeded = await installOrRequest(url).catch(() => false);
    setPending("");
    if (!canInstall || !succeeded) {
      setMessage({
        text: succeeded
          ? copy.gizmoRequested
          : canInstall
            ? copy.gizmoInstallFailed
            : copy.gizmoRequestFailed,
        error: !succeeded,
      });
    }
    return succeeded;
  }

  return (
    <div data-gizmo-market-body>
      {entries.length > 0 && (
        <div data-gizmo-listings>
          {entries.map(({ url, name, thumbnail }) => {
            const title = name[language];
            const present = installed.some((piece) => piece.url === url);
            const state = present
              ? copy.gizmoInstalled
              : requested.includes(url)
                ? copy.gizmoRequested
                : declined.includes(url)
                  ? copy.gizmoDeclined
                  : null;
            return (
              <article key={url} aria-label={title} data-gizmo-listing>
                <div data-gizmo-listing-art>
                  <img alt="" src={thumbnail} draggable={false} />
                </div>
                <div data-gizmo-listing-copy>
                  <h3>{title}</h3>
                  <a href={url} target="_blank" rel="noreferrer">
                    {copy.gizmoViewCode}
                  </a>
                </div>
                {state ? (
                  <span data-gizmo-install-state>{state}</span>
                ) : (
                  <button
                    type="button"
                    data-gizmo-market-action
                    aria-label={`${action} ${title}`}
                    disabled={!available}
                    onClick={() => void submit(url)}
                  >
                    {pending === url ? copy.loading : action}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
      {custom && (canInstall || canRequest) && (
        <form
          data-gizmo-install
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const url = form.querySelector("input")?.value.trim();
            if (url && (await submit(url))) form.reset();
          }}
        >
          <label htmlFor="gizmo-source">{copy.gizmoSource}</label>
          <div data-gizmo-source-field>
            <input
              id="gizmo-source"
              name="source"
              type="url"
              autoComplete="off"
              spellCheck={false}
              required
              aria-describedby="gizmo-source-help"
              placeholder="https://github.com/…"
            />
            <button type="submit" data-gizmo-market-action disabled={!available}>
              {action}
            </button>
          </div>
          <p id="gizmo-source-help">{copy.gizmoSourceHelp}</p>
        </form>
      )}
      {canRequest &&
        Array.from(new Set([...requested, ...declined]), (url) =>
          entries.some((entry) => entry.url === url) ? null : (
            <article key={url} data-gizmo-custom-status>
              <a href={url} target="_blank" rel="noreferrer">
                {url.slice("https://github.com/".length)}
              </a>
              <span>{requested.includes(url) ? copy.gizmoRequested : copy.gizmoDeclined}</span>
            </article>
          ),
        )}
      {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
    </div>
  );
}

export function GizmoDrawer({
  editor,
  online,
  deck,
  pieces,
  install,
  marketplace = [],
  request,
  requested = [],
  declined = [],
  custom = true,
  arrival,
  status,
  seats,
}: {
  seats?: string[];
  editor: Editor;
  online: boolean;
  deck: DeckActions;
  pieces: readonly Piece[];
  marketplace?: readonly GizmoListing[];
  install?: (url: string) => Promise<Piece>;
  request?: (url: string) => Promise<void>;
  requested?: readonly string[];
  declined?: readonly string[];
  custom?: boolean;
  arrival?: string;
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
  const [browsing, setBrowsing] = useState<{ arrival?: string } | null>();
  const [installed, setInstalled] = useState<{ url: string; arrival?: string } | null>(null);
  const arriving = installed !== null && installed.arrival === arrival ? installed.url : arrival;
  const arrivalTile = useRef<HTMLButtonElement>(null);
  const highlighted = useRef<string | undefined>(undefined);
  const marketBack = useRef<HTMLButtonElement>(null);
  const marketLink = useRef<HTMLButtonElement>(null);
  const marketVisited = useRef(false);
  const canBrowse = marketplace.length > 0 || (custom && (!!install || !!request));
  const marketplaceOpen =
    browsing === undefined
      ? canBrowse && !status && !arriving && pieces.length === 0
      : browsing !== null && browsing.arrival === arrival;
  const arrivingInstalled = pieces.some((piece) => piece.url === arriving);
  const guests = usePresent(editor);
  const grip = useRef<Grip | null>(null);
  const placing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!highlighted.current && !marketVisited.current)
      close.current?.focus({ preventScroll: true });
    if (shelf.current)
      return springGizmo(shelf.current, (t) => `translateY(${8 * t}px) scale(${1 - 0.025 * t})`);
  }, []);
  useLayoutEffect(() => {
    if (marketplaceOpen) {
      marketVisited.current = true;
      marketBack.current?.focus({ preventScroll: true });
      return;
    }
    const tile = arrivalTile.current;
    if (arrivingInstalled && arriving && tile && highlighted.current !== arriving) {
      highlighted.current = arriving;
      marketVisited.current = false;
      tile.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      tile.focus({ preventScroll: true });
      const artwork = tile.querySelector<HTMLElement>("[data-gizmo-display]");
      if (artwork)
        return springGizmo(artwork, (t) => `translateY(${t * 12}px) scale(${1 - t * 0.2})`);
    } else if (marketVisited.current) {
      marketVisited.current = false;
      marketLink.current?.focus({ preventScroll: true });
    }
  }, [arriving, arrivingInstalled, marketplaceOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      grip.current = null;
      if (marketplaceOpen) setBrowsing(null);
      else dismiss();
    };
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, [dismiss, marketplaceOpen]);

  async function installOrRequest(url: string) {
    if (install) {
      const piece = await install(url);
      setInstalled({ url: piece.url, arrival });
      setBrowsing(null);
      marketVisited.current = false;
      return true;
    }
    if (!request) return false;
    await request(url);
    return true;
  }

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
        data-gizmo-marketplace={marketplaceOpen ? "" : undefined}
        aria-labelledby="gizmo-title"
        id={PANEL_ID.gizmos}
      >
        <header>
          {marketplaceOpen && (
            <button type="button" ref={marketBack} onClick={() => setBrowsing(null)}>
              {copy.gizmoBack}
            </button>
          )}
          <h2 id="gizmo-title">{marketplaceOpen ? copy.gizmoMarketplace : copy.gizmoGallery}</h2>
          {!marketplaceOpen && (
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
          )}
          <button type="button" aria-label={copy.close} onClick={dismiss} ref={close}>
            <Icon name="Close" />
          </button>
        </header>
        {marketplaceOpen ? (
          <Marketplace
            entries={marketplace}
            installed={pieces}
            requested={requested}
            declined={declined}
            installOrRequest={installOrRequest}
            canInstall={!!install}
            canRequest={!!request}
            custom={custom}
            online={online}
          />
        ) : (
          <>
            {pieces.length > 0 && (
              <div data-gizmo-compartment>
                {pieces.map((piece) => (
                  <button
                    type="button"
                    data-gizmo-piece={piece.manifest.kind}
                    data-lifted={drag?.piece === piece || undefined}
                    key={piece.url}
                    ref={piece.url === arriving ? arrivalTile : undefined}
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
            {canBrowse && (
              <button
                type="button"
                data-gizmo-open-market
                ref={marketLink}
                onClick={() => setBrowsing({ arrival })}
              >
                {copy.gizmoBrowse}
              </button>
            )}
          </>
        )}
      </dialog>
      {drag && <CarriedPiece drag={drag} />}
    </>
  );
}
