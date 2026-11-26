import type { Editor } from "tldraw";

import {
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import "./gizmo-drawer.css";

import type { GizmoRequest, InstalledGizmo } from "../../src/gizmo-packages";
import type { DeckActions } from "./deck";

import {
  gizmoSoundsEnabled,
  setGizmoSoundsEnabled,
  playGizmoCue,
  springGizmo,
} from "./gizmo-feedback";
import { placeGizmoGeo } from "./gizmo-geo";
import { GizmoSubmit } from "./gizmo-submit";
import { useGizmoUi } from "./gizmo-ui";
import { Icon } from "./icons";
import { usePresent } from "./people";
import { PANEL_ID } from "./ui";

type Piece = InstalledGizmo;
type RequestStatus = GizmoRequest["status"];
export type GizmoListing = { url: string; name: { en: string; pl: string }; thumbnail: string };
type Point = { x: number; y: number };
type Drag = Point & { piece: Piece; tilt: number };
type Grip = Point & { piece: Piece; pointer: number; moved: boolean };
const DRAG_DISTANCE = 6;
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
  installOrRequest: (url: string) => Promise<RequestStatus | false>;
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
  const installedUrls = new Set(installed.map((piece) => piece.url));
  const listedUrls = new Set(entries.map((entry) => entry.url));
  const requestedUrls = new Set(requested);
  const declinedUrls = new Set(declined);

  async function submit(url: string) {
    if (!available) return false;
    setPending(url);
    setMessage(null);
    const result = await installOrRequest(url).catch(() => false as const);
    setPending("");
    if (!result) {
      setMessage({
        text: canInstall ? copy.gizmoInstallFailed : copy.gizmoRequestFailed,
        error: true,
      });
    } else if (!canInstall) {
      const labels = {
        pending: copy.gizmoRequested,
        installed: copy.gizmoInstalled,
        declined: copy.gizmoDeclined,
      };
      setMessage({ text: labels[result], error: false });
    }
    return !!result;
  }

  return (
    <div data-gizmo-market-body>
      {entries.length > 0 && (
        <div data-gizmo-listings>
          {entries.map(({ url, name, thumbnail }) => {
            const title = name[language];
            const present = installedUrls.has(url);
            const state = present
              ? copy.gizmoInstalled
              : requestedUrls.has(url)
                ? copy.gizmoRequested
                : declinedUrls.has(url)
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
      <GizmoSubmit
        board={custom && (canInstall || canRequest)}
        action={action}
        online={online}
        busy={!!pending}
        submit={submit}
      />
      {canRequest &&
        Array.from(new Set([...requested, ...declined]), (url) =>
          listedUrls.has(url) ? null : (
            <article key={url} data-gizmo-custom-status>
              <a href={url} target="_blank" rel="noreferrer">
                {url.slice("https://github.com/".length)}
              </a>
              <span>{requestedUrls.has(url) ? copy.gizmoRequested : copy.gizmoDeclined}</span>
            </article>
          ),
        )}
      {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
    </div>
  );
}

function useGizmoPlacement({
  editor,
  online,
  deck,
  seats,
  dismiss,
}: {
  editor: Editor;
  online: boolean;
  deck: DeckActions;
  seats?: string[];
  dismiss: () => void;
}) {
  const { locale, person } = useGizmoUi();
  const guests = usePresent(editor);
  const grip = useRef<Grip | null>(null);
  const placing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);

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
      dismiss();
    } else setFailed(true);
  }

  function grab(event: ReactPointerEvent<HTMLButtonElement>, piece: Piece) {
    if (!event.isPrimary || event.button !== 0 || grip.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    grip.current = {
      piece,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    playGizmoCue("pickup");
  }

  const move = useEffectEvent((event: PointerEvent) => {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    const dx = event.clientX - start.x;
    if (!start.moved && Math.hypot(dx, event.clientY - start.y) < DRAG_DISTANCE) return;
    start.moved = true;
    setDrag({
      piece: start.piece,
      x: event.clientX,
      y: event.clientY,
      tilt: Math.max(-14, Math.min(dx / 9, 14)),
    });
  });

  function clearGrip() {
    grip.current = null;
    setDrag(null);
  }

  const release = useEffectEvent((event: PointerEvent) => {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    clearGrip();
    const { clientX: x, clientY: y } = event;
    if (!start.moved && Math.hypot(x - start.x, y - start.y) < DRAG_DISTANCE) {
      void place(start.piece, editor.getViewportPageBounds().center);
      return;
    }
    const target = editor
      .getContainer()
      .ownerDocument.elementFromPoint(x, y)
      ?.closest(".tl-canvas");
    if (target && editor.getContainer().contains(target))
      void place(start.piece, editor.screenToPage({ x, y }));
  });

  const cancel = useEffectEvent((event: PointerEvent) => {
    if (grip.current?.pointer === event.pointerId) clearGrip();
  });
  useEffect(() => {
    const view = editor.getContainer().ownerDocument.defaultView;
    if (!view) return;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    view.addEventListener("pointermove", move, options);
    view.addEventListener("pointerup", release, options);
    view.addEventListener("pointercancel", cancel, options);
    view.addEventListener("lostpointercapture", cancel, options);
    view.addEventListener("blur", clearGrip, { signal: controller.signal });
    return () => controller.abort();
  }, [editor]);

  return { busy, failed, drag, clearGrip, place, grab };
}

function useDrawerFocus(
  marketplaceOpen: boolean,
  arriving: string | undefined,
  arrivingInstalled: boolean,
) {
  const shelf = useRef<HTMLDialogElement>(null);
  const arrivalTile = useRef<HTMLButtonElement>(null);
  const highlighted = useRef<string | undefined>(undefined);
  const marketBack = useRef<HTMLButtonElement>(null);
  const marketLink = useRef<HTMLButtonElement>(null);
  const marketVisited = useRef(false);
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

  return { shelf, close, arrivalTile, marketBack, marketLink };
}

function DrawerHeader({
  marketplaceOpen,
  marketBack,
  close,
  back,
  dismiss,
}: {
  marketplaceOpen: boolean;
  marketBack: Ref<HTMLButtonElement>;
  close: Ref<HTMLButtonElement>;
  back: () => void;
  dismiss: () => void;
}) {
  const { copy } = useGizmoUi();
  const [sounds, setSounds] = useState(gizmoSoundsEnabled);
  return (
    <header>
      {marketplaceOpen && (
        <button type="button" ref={marketBack} onClick={back}>
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
  );
}

function DrawerStatus({
  failed,
  status,
  online,
  hasPieces,
}: {
  failed: boolean;
  status?: string;
  online: boolean;
  hasPieces: boolean;
}) {
  const { copy } = useGizmoUi();
  const tableStatus = hasPieces ? copy.gizmoPlace : copy.gizmoEmpty;
  const message = failed
    ? copy.gizmoPlaceFailed
    : status || (online ? tableStatus : copy.connectionLost);
  return <p role="status">{message}</p>;
}

function useMarketplaceRoute({
  install,
  request,
  arrival,
  status,
  custom,
  empty,
  hasListings,
}: {
  install?: (url: string) => Promise<Piece>;
  request?: (url: string) => Promise<RequestStatus>;
  arrival?: string;
  status?: string;
  custom: boolean;
  empty: boolean;
  hasListings: boolean;
}) {
  const [browsing, setBrowsing] = useState<{ arrival?: string } | null>();
  const [installed, setInstalled] = useState<{ url: string; arrival?: string } | null>(null);
  const arriving = installed !== null && installed.arrival === arrival ? installed.url : arrival;
  const canBrowse = hasListings || (custom && (!!install || !!request));
  const marketplaceOpen =
    browsing === undefined
      ? canBrowse && !status && !arriving && empty
      : browsing !== null && browsing.arrival === arrival;
  async function installOrRequest(url: string) {
    if (install) {
      const piece = await install(url);
      setInstalled({ url: piece.url, arrival });
      setBrowsing(null);
      return "installed" as const;
    }
    return request ? request(url) : (false as const);
  }

  return {
    arriving,
    canBrowse,
    marketplaceOpen,
    browse: () => setBrowsing({ arrival }),
    back: () => setBrowsing(null),
    installOrRequest,
  };
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
  request?: (url: string) => Promise<RequestStatus>;
  requested?: readonly string[];
  declined?: readonly string[];
  custom?: boolean;
  arrival?: string;
  status?: string;
}) {
  const { copy, locale, close: closePanel } = useGizmoUi();
  const dismiss = useCallback(() => {
    closePanel("gizmos");
    editor
      .getContainer()
      .querySelector<HTMLElement>('[data-testid="main-menu.button"]')
      ?.focus({ preventScroll: true });
  }, [closePanel, editor]);
  const { arriving, canBrowse, marketplaceOpen, browse, back, installOrRequest } =
    useMarketplaceRoute({
      install,
      request,
      arrival,
      status,
      custom,
      empty: pieces.length === 0,
      hasListings: marketplace.length > 0,
    });
  const { shelf, close, arrivalTile, marketBack, marketLink } = useDrawerFocus(
    marketplaceOpen,
    arriving,
    pieces.some((piece) => piece.url === arriving),
  );
  const { busy, failed, drag, clearGrip, place, grab } = useGizmoPlacement({
    editor,
    online,
    deck,
    seats,
    dismiss: () => {
      if (shelf.current?.isConnected) dismiss();
    },
  });
  const escape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    clearGrip();
    if (marketplaceOpen) back();
    else dismiss();
  });
  useEffect(() => {
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, []);

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
        <DrawerHeader
          marketplaceOpen={marketplaceOpen}
          marketBack={marketBack}
          close={close}
          back={back}
          dismiss={dismiss}
        />
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
                    onPointerDown={(event) => grab(event, piece)}
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
            <DrawerStatus
              failed={failed}
              status={status}
              online={online}
              hasPieces={pieces.length > 0}
            />
            {canBrowse && (
              <button type="button" data-gizmo-open-market ref={marketLink} onClick={browse}>
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
