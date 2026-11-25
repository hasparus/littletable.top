/* oxlint-disable anti-slop/no-shape-in-symbol-names -- tldraw names its editor APIs for shape geometry and locks. */

import {
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type "TLImageShape" as BoardImage,
  "ImageShapeUtil" as ImageUtil,
  useEditor,
  useValue,
} from "tldraw";

import { dealtDeckCard, deckStack, faceDownDeckCard, isDealtCardId } from "../../src/deck-records";
import { DeckContext, type DeckDrop, type DeckPickup } from "./deck";
import { suggestDeckGrid } from "./deck-grid";
import { revealDeckCard } from "./deck-motion";
import { playGizmoCue } from "./gizmo-feedback";
import { useGizmoUi } from "./gizmo-ui";
import { landPaper, liftPaper, paperLift } from "./paper-landing";
import { trackRelease } from "./pointer-release";
import "./deck-piece.css";

const RECENT_REVEAL_MS = 5000;
const DRAG_THRESHOLD = 8;
const HOLD_MS = 300;

function DealtPaper({
  id,
  width,
  children,
}: {
  id: BoardImage["id"];
  width: number;
  children: ReactNode;
}) {
  const editor = useEditor();
  const paper = useRef<HTMLDivElement>(null);
  const tilt = useRef(0);
  const lift = useRef(0);
  const lastDrop = useContext(DeckContext)?.lastDrop;
  const moving = useValue(
    "picked up card",
    () => editor.isIn("select.translating") && editor.getSelectedShapeIds().includes(id),
    [editor, id],
  );
  useLayoutEffect(() => {
    const target = paper.current;
    if (!target) return;
    if (moving) {
      const pivot = editor.getPointInShapeSpace(id, editor.inputs.getCurrentPagePoint());
      tilt.current = pivot.x <= width / 2 ? 5 : -5;
      target.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
      const clear = liftPaper(target, tilt.current);
      return () => {
        lift.current = paperLift(target);
        clear?.();
      };
    }
    if (tilt.current !== 0) {
      const angle = tilt.current;
      tilt.current = 0;
      return landPaper(target, angle, lift.current);
    }
    const drop = lastDrop?.current;
    if (drop?.card !== id) return;
    target.style.transformOrigin = `${100 * drop.grip.x}% ${100 * drop.grip.y}%`;
    return landPaper(target, drop.grip.tilt, drop.grip.lift, drop.at);
  }, [editor, id, lastDrop, moving, width]);
  return <div ref={paper}>{children}</div>;
}

type CardFace = { src: string; at: number; travelX: number; travelY: number };

function LooseCard({
  id,
  width,
  height,
  art,
  back,
  face,
  turnedAt,
  canTurn,
}: {
  id: BoardImage["id"];
  width: number;
  height: number;
  art: ReactNode;
  back: string;
  face?: CardFace;
  turnedAt?: number;
  canTurn: boolean;
}) {
  const editor = useEditor();
  const actions = useContext(DeckContext);
  const { copy } = useGizmoUi();
  const press = useRef<AbortController | null>(null);
  const previousFace = useRef<HTMLImageElement | null>(null);
  const rememberFace = useCallback((image: HTMLImageElement | null) => {
    previousFace.current = image;
  }, []);
  const takeFace = useCallback(() => {
    const image = previousFace.current;
    previousFace.current = null;
    return image;
  }, []);
  const pendingSide = useRef<boolean | null>(null);
  const faceUp = !!face;
  useLayoutEffect(() => {
    pendingSide.current = null;
  }, [faceUp]);
  const locked = useValue(
    "card access",
    () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(id),
    [editor, id],
  );
  useEffect(() => () => press.current?.abort(), []);
  function flip(keyboardButton?: HTMLButtonElement) {
    if (
      !canTurn ||
      !actions ||
      pendingSide.current === faceUp ||
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(id)
    )
      return;
    pendingSide.current = faceUp;
    void actions.flip(editor, id, faceUp).then(
      (ok) => {
        if (!ok && pendingSide.current === faceUp) pendingSide.current = null;
        if (!ok || !keyboardButton || !editor.getShape(id)) return;
        const { activeElement, body } = keyboardButton.ownerDocument;
        if (
          activeElement === keyboardButton ||
          (!keyboardButton.isConnected && activeElement === body)
        ) {
          editor.select(id);
          editor.getContainer().focus({ preventScroll: true });
        }
      },
      () => {
        if (pendingSide.current === faceUp) pendingSide.current = null;
      },
    );
  }
  function point(event: PointerEvent<HTMLButtonElement>) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      !editor.isIn("select")
    )
      return;
    press.current?.abort();
    const controller = new AbortController();
    press.current = controller;
    const { clientX, clientY, pointerId } = event;
    const motion = trackRelease(event.nativeEvent);
    let dragged = false;
    const maxDistance =
      event.pointerType === "touch"
        ? editor.options.coarseDragDistanceSquared
        : editor.options.dragDistanceSquared;
    const options = { capture: true, signal: controller.signal };
    const view = event.currentTarget.ownerDocument.defaultView ?? globalThis.window;
    function moved(e: globalThis.PointerEvent) {
      return (e.clientX - clientX) ** 2 + (e.clientY - clientY) ** 2 > maxDistance;
    }
    view.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerId !== pointerId) return;
        motion.move(e);
        if (moved(e)) dragged = true;
      },
      options,
    );
    view.addEventListener("pointercancel", () => controller.abort(), options);
    view.addEventListener(
      "pointerup",
      (e) => {
        if (e.pointerId !== pointerId) return;
        controller.abort();
        if (editor.inputs.getIsPinching() || editor.inputs.getIsPanning() || !editor.isIn("select"))
          return;
        if (dragged || moved(e) || editor.inputs.getIsDragging()) {
          if (motion.isToss(e)) queueMicrotask(() => flip());
          return;
        }
        const local = editor.getPointInShapeSpace(
          id,
          editor.screenToPage({ x: e.clientX, y: e.clientY }),
        );
        if (local.x >= 0 && local.x <= width && local.y >= 0 && local.y <= height) flip();
      },
      options,
    );
  }
  return (
    <DealtPaper id={id} width={width}>
      <div data-deck-piece data-deck-down={faceUp ? undefined : ""} style={{ width, height }}>
        {face ? (
          <DeckRevealEffect art={art} back={back} face={face} rememberFace={rememberFace} />
        ) : (
          <FaceDownPaper art={art} back={back} takeFace={takeFace} turnedAt={turnedAt} />
        )}
        {canTurn && actions && !locked && (
          <button
            type="button"
            data-deck-flip
            aria-label={copy.deckFlip}
            onPointerDown={point}
            onClick={(event) => {
              if (event.detail === 0) flip(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            onKeyUp={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          />
        )}
      </div>
    </DealtPaper>
  );
}

function FaceDownPaper({
  art,
  back,
  takeFace,
  turnedAt,
}: {
  art: ReactNode;
  back: string;
  takeFace: () => HTMLImageElement | null;
  turnedAt?: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const image = takeFace();
    const paper = card.current,
      native = front.current,
      from = outgoing.current;
    if (
      !image ||
      !paper ||
      !native ||
      !from ||
      turnedAt === undefined ||
      Date.now() - turnedAt > RECENT_REVEAL_MS
    )
      return;
    from.replaceChildren(image);
    const clear = () => image.remove();
    const stop = revealDeckCard(paper, native, null, back, true, 0, 0, clear);
    return () => {
      stop();
      clear();
    };
  }, [back, takeFace, turnedAt]);
  return (
    <div data-deck-back-scene ref={card}>
      <div data-deck-to-back ref={front}>
        {art}
      </div>
      <div data-deck-from ref={outgoing} aria-hidden="true" />
    </div>
  );
}

function DeckRevealEffect({
  art,
  back,
  face,
  rememberFace,
}: {
  art: ReactNode;
  back: string;
  face: CardFace;
  rememberFace: (image: HTMLImageElement | null) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  const { src, at, travelX, travelY } = face;
  useLayoutEffect(() => {
    const paper = card.current,
      native = front.current;
    if (!paper || !native || !sheen.current) return;
    const stop = revealDeckCard(
      paper,
      native,
      sheen.current,
      src,
      Date.now() - at <= RECENT_REVEAL_MS,
      travelX,
      travelY,
    );
    return () => {
      if (paper.dataset.deckWaiting === undefined) {
        const url = new URL(src, document.baseURI).href;
        rememberFace(
          [...native.getElementsByTagName("img")].find(
            (img) => img.currentSrc === url && img.complete && img.naturalWidth > 0,
          ) ?? null,
        );
      }
      stop();
    };
  }, [src, at, travelX, travelY, rememberFace]);
  return (
    <div data-deck-card data-deck-waiting="" ref={card}>
      <div data-deck-front ref={front}>
        {art}
        <span aria-hidden="true" data-deck-reveal ref={sheen} />
      </div>
      <img alt="" data-deck-turn src={back} />
    </div>
  );
}

type Point = { x: number; y: number };
type Grip = {
  pickup: DeckPickup;
  motion: ReturnType<typeof trackRelease>;
  pointer: number;
  pressed: number;
  start: Point;
  center: Point;
  width: number;
  height: number;
  angle: number;
};
type Held = Point & {
  width: number;
  height: number;
  angle: number;
  pivot: Point;
  tilt: number;
  released?: { at: number; lift: number };
  card?: BoardImage["id"];
};

function HeldPaper({
  held,
  back,
  grip,
}: {
  held: Held;
  back: string;
  grip: RefObject<HTMLDivElement | null>;
}) {
  const { tilt, released } = held;
  useLayoutEffect(() => {
    const target = grip.current;
    if (!target || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (released === undefined) return liftPaper(target, tilt);
    return landPaper(target, tilt, released.lift, released.at);
  }, [grip, released, tilt]);
  return createPortal(
    <div
      aria-hidden="true"
      data-deck-ghost
      style={{
        width: held.width,
        height: held.height,
        left: held.x,
        top: held.y,
        transform: `translate(-50%, -50%) rotate(${held.angle}rad)`,
      }}
    >
      <div
        ref={grip}
        style={{
          width: "100%",
          height: "100%",
          transformOrigin: `${held.pivot.x}px ${held.pivot.y}px`,
        }}
      >
        <img
          data-deck-paper
          alt=""
          draggable={false}
          src={back}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>,
    document.body,
  );
}

function heldAt(grip: Grip, x: number, y: number) {
  const dx = grip.start.x - grip.center.x;
  const dy = grip.start.y - grip.center.y;
  const localX = dx * Math.cos(grip.angle) + dy * Math.sin(grip.angle);
  const localY = dy * Math.cos(grip.angle) - dx * Math.sin(grip.angle);
  return {
    pivot: { x: grip.width / 2 + localX, y: grip.height / 2 + localY },
    tilt: localX <= 0 ? 5 : -5,
    x: grip.center.x + x - grip.start.x,
    y: grip.center.y + y - grip.start.y,
    width: grip.width,
    height: grip.height,
    angle: grip.angle,
  };
}

function DeckDraw({ id, back }: { id: BoardImage["id"]; back: string }) {
  const actions = useContext(DeckContext);
  const hintId = useId();
  const { copy } = useGizmoUi();
  const editor = useEditor();
  const readonly = useValue(
    "deck access",
    () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(id),
    [editor, id],
  );
  const grip = useRef<Grip | null>(null);
  const heldPaper = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const [held, setHeld] = useState<Held | null>(null);
  const cardId = held?.card;
  const landed = useValue("dealt card", () => !!cardId && editor.getShape(cardId) !== undefined, [
    editor,
    cardId,
  ]);
  useEffect(() => () => grip.current?.pickup.cancel(), []);
  const holding = held !== null && held.released === undefined;
  if (landed && held) setHeld(null);
  useEffect(() => {
    if (!holding) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !grip.current) return;
      moved.current = true;
      grip.current.pickup.cancel();
      grip.current = null;
      setHeld(null);
    };
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, [holding]);
  if (!actions?.canDeal || readonly) return <img alt="" data-deck-top src={back} />;
  function grab(event: PointerEvent<HTMLButtonElement>) {
    if (!actions || !event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const zoom = editor.getZoomLevel();
    moved.current = false;
    grip.current?.pickup.cancel();
    grip.current = {
      pickup: actions.prepare(editor, id),
      motion: trackRelease(event),
      pointer: event.pointerId,
      pressed: event.timeStamp,
      start: { x: event.clientX, y: event.clientY },
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      width: target.offsetWidth * zoom,
      height: target.offsetHeight * zoom,
      angle: editor.getShapePageTransform(id).rotation(),
    };
    setHeld(heldAt(grip.current, event.clientX, event.clientY));
    target.setPointerCapture(event.pointerId);
    playGizmoCue("pickup");
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    start.motion.move(event.nativeEvent);
    if (
      !moved.current &&
      Math.hypot(event.clientX - start.start.x, event.clientY - start.start.y) < DRAG_THRESHOLD
    )
      return;
    moved.current = true;
    setHeld(heldAt(start, event.clientX, event.clientY));
  }
  function cancel(event: PointerEvent<HTMLButtonElement>) {
    if (grip.current?.pointer !== event.pointerId) return;
    moved.current = true;
    grip.current.pickup.cancel();
    grip.current = null;
    setHeld(null);
  }
  function dealToGrid(top: HTMLElement, pickup?: DeckPickup) {
    const stack = top.closest("[data-deck-stack]");
    if (!stack || !actions) {
      pickup?.cancel();
      return;
    }
    const rect = stack.getBoundingClientRect();
    const grid = suggestDeckGrid(editor, rect, top.getBoundingClientRect());
    const origin = editor.screenToPage({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    void actions.draw(editor, id, grid, origin, { grid, pickup });
  }
  function release(event: PointerEvent<HTMLButtonElement>) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    grip.current = null;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!actions || !target?.closest(".tl-canvas") || !editor.getContainer().contains(target)) {
      start.pickup.cancel();
      setHeld(null);
      return;
    }
    const tapped =
      !moved.current &&
      event.timeStamp - start.pressed < HOLD_MS &&
      Math.hypot(event.clientX - start.start.x, event.clientY - start.start.y) < DRAG_THRESHOLD;
    if (tapped) {
      setHeld(null);
      dealToGrid(event.currentTarget, start.pickup);
      return;
    }
    const land = heldAt(start, event.clientX, event.clientY);
    const faceDown = !start.motion.isToss(event);
    const point = editor.screenToPage(land);
    const at = performance.now();
    const lift = paperLift(heldPaper.current);
    setHeld({ ...land, released: { at, lift } });
    function track(drop: DeckDrop) {
      setHeld((current) =>
        current?.released?.at === at ? { ...current, card: drop.card } : current,
      );
    }
    const gripPoint = {
      lift,
      tilt: land.tilt,
      x: land.pivot.x / land.width,
      y: land.pivot.y / land.height,
    };
    void actions
      .draw(editor, id, point, point, {
        pickup: start.pickup,
        faceDown,
        release: { at, track, grip: gripPoint },
      })
      .then((ok) => {
        if (!ok) setHeld((current) => (current?.released?.at === at ? null : current));
      });
  }

  return (
    <>
      <button
        type="button"
        aria-label={actions.drawing === id ? copy.deckDrawing : copy.deckDraw}
        data-deck-top
        data-deck-draw
        data-deck-lifted={held ? "" : undefined}
        aria-describedby={hintId}
        title={copy.deckGesture}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onLostPointerCapture={cancel}
        onPointerCancel={cancel}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) dealToGrid(event.currentTarget);
        }}
      >
        <img alt="" draggable={false} src={back} />
      </button>
      <span data-deck-hint id={hintId}>
        {copy.deckGesture}
      </span>
      {actions.failedDeck === id && (
        <span data-deck-error role="alert">
          {copy.deckDrawFailed}
        </span>
      )}
      {held && !landed && <HeldPaper held={held} back={back} grip={heldPaper} />}
    </>
  );
}

export class DeckImageUtil extends ImageUtil {
  override canCrop(image: BoardImage) {
    const { meta, id } = image;
    if (deckStack.isValid(meta) && meta.deckId === id) return false;
    if (faceDownDeckCard.isValid(meta) || dealtDeckCard.isValid(meta)) {
      return !isDealtCardId(meta.deckId, id);
    }
    return super.canCrop(image);
  }

  override component(image: BoardImage) {
    const illustration = super.component(image);
    const { meta } = image;
    if (deckStack.isValid(meta) && meta.deckId === image.id) {
      return (
        <div
          data-deck-stack={image.id}
          data-deck-full={meta.deckRemaining === meta.deckSize ? "" : undefined}
          data-deck-thin={meta.deckRemaining < meta.deckSize / 4 ? "" : undefined}
          style={{ height: image.props.h, width: image.props.w }}
        >
          {illustration}
          <span data-deck-base aria-hidden="true">
            <i />
            {meta.deckRemaining}
            <i />
          </span>
          <DeckDraw back={meta.deckBack} id={image.id} />
        </div>
      );
    }
    if (faceDownDeckCard.isValid(meta) && meta.deckCardId === image.id) {
      return (
        <LooseCard
          id={image.id}
          art={illustration}
          width={image.props.w}
          height={image.props.h}
          back={meta.deckBack}
          canTurn
          turnedAt={meta.deckTurnedAt}
        />
      );
    }
    if (dealtDeckCard.isValid(meta)) {
      return (
        <LooseCard
          id={image.id}
          art={illustration}
          width={image.props.w}
          height={image.props.h}
          back={meta.deckBack}
          canTurn={
            meta.deckCardId === image.id ||
            (meta.deckCardId === undefined && isDealtCardId(meta.deckId, image.id))
          }
          face={{
            src: meta.deckFace,
            at: meta.deckTurnedAt ?? meta.deckDealtAt,
            travelX: meta.deckTurnedAt === undefined ? meta.deckTravelX : 0,
            travelY: meta.deckTurnedAt === undefined ? meta.deckTravelY : 0,
          }}
        />
      );
    }
    return illustration;
  }
}
