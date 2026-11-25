import type { "TLImageShape" as BoardImage } from "tldraw";

import { type PointerEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { "ImageShapeUtil" as ImageUtil, useEditor, useValue } from "tldraw";

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
  useEffect(() => {
    const target = canvas.current;
    const dealtCard = card.current;
    if (
      target === null ||
      dealtCard === null ||
      Date.now() - dealtAt > RECENT_REVEAL_MS ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    const direction = travelX > 0 ? -1 : 1;
    const tilt = direction * 14;
    const finishFlip = springGizmo(dealtCard, (displacement) => {
      const x = travelX * displacement;
      const y = travelY * displacement;
      const flip = direction * 170 * displacement;
      return `translate(${x}px, ${y}px) perspective(500px) rotateY(${flip}deg) rotateZ(${tilt * displacement}deg) scale(${1 - 0.12 * displacement})`;
    });
    const stopHighlight = startHighlight(target, src);
    return () => {
      stopHighlight();
      finishFlip();
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

type Grip = { pointer: number; x: number; y: number };

function DeckDraw({ id, back }: { id: BoardImage["id"]; back: string }) {
  const deckActions = useContext(DeckContext);
  const { copy } = useGizmoUi();
  const editor = useEditor();
  const readonly = useValue("read-only board", () => editor.getIsReadonly(), [editor]);
  const grip = useRef<Grip | null>(null);
  const dragged = useRef(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; tilt: number } | null>(null);
  if (deckActions === undefined || readonly) return null;

  const drawing = deckActions.drawing === id;
  function grab(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (!event.isPrimary || event.button !== 0) return;
    playGizmoCue("pickup");
    dragged.current = false;
    grip.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = grip.current;
    if (start?.pointer !== event.pointerId) return;
    event.stopPropagation();
    const { clientX: x, clientY: y } = event;
    if (!dragged.current && Math.hypot(x - start.x, y - start.y) < DRAG_THRESHOLD) return;
    dragged.current = true;
    setGhost({ x, y, tilt: Math.max(-23, Math.min(23, (x - start.x) / 8)) });
  }

  function release(event: PointerEvent<HTMLButtonElement>) {
    if (grip.current?.pointer !== event.pointerId) return;
    event.stopPropagation();
    grip.current = null;
    setGhost(null);
    if (dragged.current && deckActions) {
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      void deckActions.draw(editor, id, point, point, true);
    }
  }

  return (
    <>
      <button
        aria-label={drawing ? copy.deckDrawing : copy.deckDraw}
        data-deck-dragging={ghost === null ? undefined : ""}
        data-deck-draw
        title={copy.deckDraw}
        disabled={deckActions.drawing !== null}
        onClick={(event) => {
          event.stopPropagation();
          if (dragged.current && event.detail !== 0) return;
          if (event.detail === 0) playGizmoCue("pickup");
          const deck = event.currentTarget.closest("[data-deck-stack]");
          if (deck === null) return;
          const { left, right, width, top, height } = deck.getBoundingClientRect();
          const viewport = editor.getContainer().getBoundingClientRect();
          const offset = width / 2 + 12;
          const spaceRight = viewport.right - right;
          const spaceLeft = left - viewport.left;
          const x =
            spaceRight >= width + 12 || spaceRight >= spaceLeft ? right + offset : left - offset;
          const y = top + height / 2;
          const origin = editor.screenToPage({ x: left + width / 2, y });
          const point = editor.screenToPage({ x, y });
          void deckActions.draw(editor, id, point, origin, false);
        }}
        onPointerCancel={() => {
          grip.current = null;
          setGhost(null);
        }}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={release}
        type="button"
      />
      {deckActions.failedDeck === id && (
        <span data-deck-error role="alert">
          {copy.deckDrawFailed}
        </span>
      )}
      {ghost &&
        createPortal(
          <img
            alt=""
            data-deck-ghost
            src={back}
            style={{ left: ghost.x, top: ghost.y, rotate: `${ghost.tilt}deg` }}
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
          data-deck-thin={meta.deckRemaining < meta.deckSize / 4 ? "" : undefined}
          style={{ height: image.props.h, width: image.props.w }}
        >
          {illustration}
          <img alt="" data-deck-top src={meta.deckBack} />
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
