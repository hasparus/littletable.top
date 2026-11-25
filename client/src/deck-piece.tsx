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

import { dealtDeckCard, deckStack } from "../../src/deck-records";
import { DeckContext, type DeckDrop } from "./deck";
import { usePreloadDeckArt } from "./deck-art";
import { suggestDeckGrid } from "./deck-grid";
import { revealDeckCard, turnHeldBack } from "./deck-motion";
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

function DeckRevealEffect({
  id,
  art,
  back,
  dealtAt,
  height,
  travelX,
  travelY,
  width,
}: {
  id: BoardImage["id"];
  art: ReactNode;
  back: string;
  dealtAt: number;
  height: number;
  travelX: number;
  travelY: number;
  width: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  const lastDrop = useContext(DeckContext)?.lastDrop;
  useLayoutEffect(() => {
    const paper = card.current;
    const target = sheen.current;
    if (!paper || !target || Date.now() - dealtAt > RECENT_REVEAL_MS) return;
    const drop = lastDrop?.current;
    return revealDeckCard(paper, target, travelX, travelY, drop?.card === id ? drop.at : undefined);
  }, [dealtAt, id, lastDrop, travelX, travelY]);
  return (
    <DealtPaper id={id} width={width}>
      <div data-deck-card ref={card} style={{ height, width }}>
        <div
          data-deck-front
          style={{ backgroundImage: `url("${back}")`, backgroundSize: "100% 100%" }}
          onLoadCapture={(event) => {
            if (event.target instanceof HTMLImageElement)
              event.currentTarget.style.backgroundImage = "none";
          }}
        >
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
  const paper = useRef<HTMLImageElement>(null);
  const { tilt, released } = held;
  useLayoutEffect(() => {
    const target = grip.current;
    const face = paper.current;
    if (!target || !face || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (released === undefined) return liftPaper(target, tilt);
    const relax = landPaper(target, tilt, released.lift, released.at);
    const turn = turnHeldBack(face, released.at);
    return () => {
      relax?.();
      turn.cancel();
    };
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
          ref={paper}
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

function DeckArtPreload({ back }: { back: string }) {
  const marker = usePreloadDeckArt(back);
  return <span aria-hidden="true" hidden ref={marker} />;
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
  const holding = held !== null && held.released === undefined;
  if (landed && held) setHeld(null);
  useEffect(() => {
    if (!holding) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !grip.current) return;
      moved.current = true;
      grip.current = null;
      setHeld(null);
    };
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, [holding]);
  if (actions === undefined || readonly) return <img alt="" data-deck-top src={back} />;
  function grab(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const zoom = editor.getZoomLevel();
    moved.current = false;
    grip.current = {
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
    grip.current = null;
    setHeld(null);
  }
  function release(event: PointerEvent<HTMLButtonElement>) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    grip.current = null;
    if (!moved.current && event.timeStamp - start.pressed >= HOLD_MS) moved.current = true;
    if (!moved.current || !actions) {
      setHeld(null);
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target?.closest(".tl-canvas") || !editor.getContainer().contains(target)) {
      setHeld(null);
      return;
    }
    const land = heldAt(start, event.clientX, event.clientY);
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
      .draw(editor, id, point, point, { release: { at, track, grip: gripPoint } })
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
          if (event.detail !== 0 && moved.current) return;
          const stack = event.currentTarget.closest("[data-deck-stack]");
          if (!stack) return;
          const rect = stack.getBoundingClientRect();
          const grid = suggestDeckGrid(editor, rect, event.currentTarget.getBoundingClientRect());
          const origin = editor.screenToPage({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
          void actions.draw(editor, id, grid, origin, { grid });
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
          <DeckArtPreload back={meta.deckBack} />
          <DeckDraw back={meta.deckBack} id={image.id} />
        </div>
      );
    }
    if (dealtDeckCard.isValid(meta)) {
      return (
        <DeckRevealEffect
          id={image.id}
          art={illustration}
          back={meta.deckBack}
          dealtAt={meta.deckDealtAt}
          height={image.props.h}
          travelX={meta.deckTravelX}
          travelY={meta.deckTravelY}
          width={image.props.w}
        />
      );
    }
    return illustration;
  }
}
