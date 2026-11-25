/* oxlint-disable anti-slop/no-shape-in-symbol-names -- tldraw names its editor APIs for shape geometry and locks. */

import {
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Box,
  type Editor,
  type "TLImageShape" as BoardImage,
  "ImageShapeUtil" as ImageUtil,
  useEditor,
  useValue,
} from "tldraw";

import { dealtDeckCard, deckStack } from "../../src/deck-records";
import { DeckContext } from "./deck";
import { playGizmoCue, springGizmo } from "./gizmo-feedback";
import { useGizmoUi } from "./gizmo-ui";
import "./deck-piece.css";

const RECENT_REVEAL_MS = 5000;
const DRAG_THRESHOLD = 8;

function startHighlight(target: HTMLCanvasElement, src: string) {
  const lifetime = new AbortController();
  if ("gpu" in navigator) {
    void import("./deck-reveal-gpu")
      .then(({ playDeckReveal }) => playDeckReveal(target, src, lifetime.signal))
      .catch(() => lifetime.abort());
  }
  return () => lifetime.abort();
}

function DeckRevealEffect({
  art,
  back,
  dealtAt,
  height,
  src,
  travelX,
  travelY,
  width,
}: {
  art: ReactNode;
  back: string;
  dealtAt: number;
  height: number;
  src: string;
  travelX: number;
  travelY: number;
  width: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const target = canvas.current;
    const paper = card.current;
    if (!target || !paper || Date.now() - dealtAt > RECENT_REVEAL_MS) return;
    const image = new Image();
    image.src = src;
    let active = true;
    let stopTurn: (() => void) | undefined;
    let stopLight: (() => void) | undefined;
    paper.style.setProperty("--deck-start-x", travelX + "px");
    paper.style.setProperty("--deck-start-y", travelY + "px");
    paper.dataset.deckWaiting = "";
    function turn() {
      if (!active || !paper || !target) return;
      delete paper.dataset.deckWaiting;
      if (
        matchMedia("(prefers-reduced-motion: reduce)").matches ||
        Date.now() - dealtAt > RECENT_REVEAL_MS
      )
        return;
      const side = travelX > 0 ? -1 : 1;
      stopTurn = springGizmo(paper, (t) => {
        const turn = Math.max(0, Math.min(1, t));
        return `translate(${travelX * t}px, ${travelY * t}px) perspective(700px) rotateY(${side * 180 * turn}deg) rotateZ(${side * 4 * t}deg)`;
      });
      stopLight = startHighlight(target, src);
    }
    void image.decode().then(turn, () => {
      if (paper) delete paper.dataset.deckWaiting;
    });
    return () => {
      active = false;
      delete paper.dataset.deckWaiting;
      stopLight?.();
      stopTurn?.();
    };
  }, [dealtAt, src, travelX, travelY]);
  return (
    <div data-deck-card ref={card} style={{ height, width }}>
      <div data-deck-front>
        {art}
        <canvas aria-hidden="true" data-deck-reveal ref={canvas} />
      </div>
      <img alt="" data-deck-turn src={back} />
    </div>
  );
}

type Point = { x: number; y: number };
type Grip = {
  pointer: number;
  start: Point;
  center: Point;
  width: number;
  height: number;
  angle: number;
};
type Held = Point & { width: number; height: number; angle: number };

function nextDeal(editor: Editor, id: BoardImage["id"]) {
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) return null;
  const viewport = editor.getViewportPageBounds();
  const gap = 10 / editor.getZoomLevel();
  const { w, h } = bounds;
  const origin = bounds.center;
  const side = viewport.maxX - bounds.maxX >= bounds.minX - viewport.minX ? 1 : -1;
  const occupied = editor.getCurrentPageShapes().map((piece) => editor.getShapePageBounds(piece));
  const shelf = editor
    .getContainer()
    .closest("[data-board-shell]")
    ?.querySelector("[data-gizmo-shelf]");
  if (shelf) {
    const rect = shelf.getBoundingClientRect();
    const corner = editor.screenToPage({ x: rect.left, y: rect.top });
    occupied.push(
      new Box(
        corner.x,
        corner.y,
        rect.width / editor.getZoomLevel(),
        rect.height / editor.getZoomLevel(),
      ),
    );
  }
  for (const row of [0, 1, -1, 2, -2]) {
    const columns = row === 0 ? [1, 2, 3, -1, -2, -3] : [0, 1, 2, 3, -1, -2, -3];
    for (const col of columns) {
      const slot = new Box(
        origin.x + side * col * (w + gap) - w / 2,
        origin.y + row * (h + gap) - (row < 0 ? h * 0.13 : 0) - h / 2,
        w,
        h,
      );
      if (viewport.contains(slot) && occupied.every((other) => !other || !other.collides(slot)))
        return { origin, point: slot.center };
    }
  }
  const x = Math.max(
    viewport.minX + w / 2,
    Math.min(viewport.maxX - w / 2, origin.x + side * (w + gap)),
  );
  const y = Math.max(viewport.minY + h / 2, Math.min(viewport.maxY - h / 2, origin.y));
  return { origin, point: { x, y } };
}

function heldAt(grip: Grip, x: number, y: number) {
  return {
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
  const moved = useRef(false);
  const [held, setHeld] = useState<Held | null>(null);
  const holding = held !== null;
  useEffect(() => {
    if (!holding) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !grip.current) return;
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
      start: { x: event.clientX, y: event.clientY },
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      width: target.offsetWidth * zoom,
      height: target.offsetHeight * zoom,
      angle: editor.getShapePageTransform(id).rotation(),
    };
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
    if (!moved.current || !actions) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (
      target?.closest<HTMLElement>("[data-deck-stack]")?.dataset.deckStack === id ||
      !target?.closest(".tl-canvas") ||
      !editor.getContainer().contains(target)
    ) {
      setHeld(null);
      return;
    }
    const land = heldAt(start, event.clientX, event.clientY);
    const point = editor.screenToPage(land);
    setHeld(land);
    void actions.draw(editor, id, point, point, true).finally(() => setHeld(null));
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
        disabled={actions.drawing !== null}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        onLostPointerCapture={cancel}
        onPointerCancel={cancel}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail !== 0 && moved.current) return;
          const deal = nextDeal(editor, id);
          if (deal) void actions.draw(editor, id, deal.point, deal.origin, false);
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
      {held &&
        createPortal(
          <img
            alt=""
            draggable={false}
            data-deck-ghost
            src={back}
            style={{
              width: held.width,
              height: held.height,
              left: held.x,
              top: held.y,
              transform: `translate(-50%, -50%) rotate(${held.angle}rad)`,
            }}
          />,
          document.body,
        )}
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
    if (dealtDeckCard.isValid(meta)) {
      return (
        <DeckRevealEffect
          art={illustration}
          back={meta.deckBack}
          dealtAt={meta.deckDealtAt}
          height={image.props.h}
          src={meta.deckFace}
          travelX={meta.deckTravelX}
          travelY={meta.deckTravelY}
          width={image.props.w}
        />
      );
    }
    return illustration;
  }
}
