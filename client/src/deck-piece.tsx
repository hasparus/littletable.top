/* oxlint-disable anti-slop/no-shape-in-symbol-names -- tldraw names its editor APIs for shape geometry and locks. */

import {
  type PointerEvent,
  type ReactNode,
  type RefObject,
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

import { dealtDeckCard, deckStack, faceDownDeckCard } from "../../src/deck-records";
import { DeckContext, type DeckDrop, type DeckPickup } from "./deck";
import { suggestDeckGrid } from "./deck-grid";
import { revealDeckCard } from "./deck-motion";
import { playGizmoCue } from "./gizmo-feedback";
import { useGizmoUi } from "./gizmo-ui";
import { landPaper, liftPaper, paperLift } from "./paper-landing";
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

function FaceDownPaper({
  id,
  width,
  height,
  art,
}: {
  id: BoardImage["id"];
  width: number;
  height: number;
  art: ReactNode;
}) {
  const editor = useEditor();
  const actions = useContext(DeckContext);
  const { copy } = useGizmoUi();
  const press = useRef<AbortController | null>(null);
  const turning = useRef(false);
  const locked = useValue(
    "card access",
    () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(id),
    [editor, id],
  );
  useEffect(() => () => press.current?.abort(), []);
  function flip(keyboardButton?: HTMLButtonElement) {
    if (!actions || turning.current || editor.getIsReadonly() || editor.isShapeOrAncestorLocked(id))
      return;
    turning.current = true;
    void actions.flip(editor, id).then(
      (ok) => {
        turning.current = ok;
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
        turning.current = false;
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
        if (e.pointerId === pointerId && moved(e)) controller.abort();
      },
      options,
    );
    view.addEventListener("pointercancel", () => controller.abort(), options);
    view.addEventListener(
      "pointerup",
      (e) => {
        if (e.pointerId !== pointerId) return;
        controller.abort();
        const local = editor.getPointInShapeSpace(
          id,
          editor.screenToPage({ x: e.clientX, y: e.clientY }),
        );
        if (
          local.x >= 0 &&
          local.x <= width &&
          local.y >= 0 &&
          local.y <= height &&
          !moved(e) &&
          !editor.inputs.getIsDragging() &&
          !editor.inputs.getIsPanning() &&
          !editor.inputs.getIsPinching()
        )
          flip();
      },
      options,
    );
  }
  return (
    <DealtPaper id={id} width={width}>
      <div data-deck-down style={{ width, height }}>
        {art}
        {actions && !locked && (
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

function DeckRevealEffect({
  id,
  art,
  back,
  face,
  dealtAt,
  height,
  travelX,
  travelY,
  width,
}: {
  id: BoardImage["id"];
  art: ReactNode;
  back: string;
  face: string;
  dealtAt: number;
  height: number;
  travelX: number;
  travelY: number;
  width: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const front = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!card.current || !front.current || !sheen.current) return;
    return revealDeckCard(
      card.current,
      front.current,
      sheen.current,
      face,
      Date.now() - dealtAt <= RECENT_REVEAL_MS,
      travelX,
      travelY,
    );
  }, [dealtAt, face, travelX, travelY]);
  return (
    <DealtPaper id={id} width={width}>
      <div data-deck-card data-deck-waiting="" ref={card} style={{ height, width }}>
        <div data-deck-front ref={front}>
          {art}
          <span aria-hidden="true" data-deck-reveal ref={sheen} />
        </div>
        <img alt="" data-deck-turn src={back} />
      </div>
    </DealtPaper>
  );
}

type Point = { x: number; y: number };
type Grip = {
  pickup: DeckPickup;
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

function nearDeck(card: Point, top: HTMLElement, rotation: number, zoom: number) {
  const rect = top.getBoundingClientRect();
  const dx = card.x - rect.left - rect.width / 2;
  const dy = card.y - rect.top - rect.height / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const margin = 0.12 * Math.min(top.offsetWidth, top.offsetHeight) * zoom;
  return (
    Math.abs(dx * cos + dy * sin) <= (top.offsetWidth * zoom) / 2 + margin &&
    Math.abs(dy * cos - dx * sin) <= (top.offsetHeight * zoom) / 2 + margin
  );
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
    if (!moved.current && event.timeStamp - start.pressed >= HOLD_MS) moved.current = true;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!actions || !target?.closest(".tl-canvas") || !editor.getContainer().contains(target)) {
      start.pickup.cancel();
      setHeld(null);
      return;
    }
    if (!moved.current) {
      setHeld(null);
      dealToGrid(event.currentTarget, start.pickup);
      return;
    }
    const land = heldAt(start, event.clientX, event.clientY);
    const faceDown = nearDeck(
      land,
      event.currentTarget,
      editor.getShapePageTransform(id).rotation(),
      editor.getZoomLevel(),
    );
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
    return !deckStack.isValid(image.meta) || image.meta.deckId !== image.id;
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
        <FaceDownPaper
          id={image.id}
          art={illustration}
          width={image.props.w}
          height={image.props.h}
        />
      );
    }
    if (dealtDeckCard.isValid(meta)) {
      return (
        <DeckRevealEffect
          id={image.id}
          art={illustration}
          back={meta.deckBack}
          face={meta.deckFace}
          dealtAt={meta.deckTurnedAt ?? meta.deckDealtAt}
          height={image.props.h}
          travelX={meta.deckTurnedAt === undefined ? meta.deckTravelX : 0}
          travelY={meta.deckTurnedAt === undefined ? meta.deckTravelY : 0}
          width={image.props.w}
        />
      );
    }
    return illustration;
  }
}
