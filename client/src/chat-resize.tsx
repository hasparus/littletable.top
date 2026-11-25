import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";

import { PANEL_ID, useBoardUi } from "./ui";

export type ChatSize = { height?: number; width?: number; left?: number; bottom?: number };

const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof edges)[number];

type Drag = {
  edge: Edge;
  pointer: number;
  rect: DOMRect;
  size: ChatSize;
  x: number;
  y: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const desktop = () => matchMedia("(min-width: 40rem)").matches;

function resize(size: ChatSize, rect: DOMRect, edge: Edge, dx: number, dy: number) {
  const next = { ...size };
  const margin = 8;
  if (desktop() && (edge.includes("e") || edge.includes("w"))) {
    const left = edge.includes("w") ? clamp(rect.left + dx, margin, rect.right - 256) : rect.left;
    const right = edge.includes("e")
      ? clamp(rect.right + dx, left + 256, innerWidth - margin)
      : rect.right;
    next.width = right - left;
    next.left = left;
    next.height = rect.height;
    next.bottom = innerHeight - rect.bottom;
  }
  if (edge.includes("n") || edge.includes("s")) {
    const top = edge.includes("n") ? clamp(rect.top + dy, margin, rect.bottom - 144) : rect.top;
    const bottom = edge.includes("s")
      ? clamp(rect.bottom + dy, top + 144, innerHeight - margin)
      : rect.bottom;
    next.height = bottom - top;
    if (desktop()) next.bottom = innerHeight - bottom;
  }
  return next;
}

export function ChatResize({
  change,
  sheet,
  size,
}: {
  change: (size: ChatSize) => void;
  sheet: RefObject<HTMLElement | null>;
  size: ChatSize;
}) {
  const { copy } = useBoardUi();
  const hint = useId();
  const control = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const panel = sheet.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      control.current?.setAttribute("aria-valuenow", String(Math.round(panel.offsetHeight)));
      control.current?.setAttribute("aria-valuemax", String(innerHeight));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [sheet]);

  function keyDown(event: KeyboardEvent) {
    const rect = sheet.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    const dy = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0;
    if (event.key === "Enter" || event.key === " ") {
      change(
        size.width !== undefined || size.height !== undefined
          ? {}
          : resize(size, rect, "ne", 120, -120),
      );
    } else if (dy || (dx && desktop())) {
      change(resize(size, rect, dy ? "n" : "e", dx, dy));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function start(event: PointerEvent<HTMLDivElement>, edge: Edge) {
    if (!event.isPrimary || event.button !== 0 || !sheet.current) return;
    event.preventDefault();
    drag.current = {
      pointer: event.pointerId,
      rect: sheet.current.getBoundingClientRect(),
      size,
      edge,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    control.current?.focus({ preventScroll: true });
  }

  function move(event: PointerEvent) {
    const from = drag.current;
    if (from?.pointer !== event.pointerId) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    change(resize(from.size, from.rect, from.edge, dx, dy));
  }

  return (
    <>
      <span className="sr-only" id={hint}>
        {copy.chatResizeHint}
      </span>
      <div
        aria-controls={PANEL_ID.chat}
        aria-describedby={hint}
        aria-label={copy.chatResize}
        aria-orientation="horizontal"
        aria-valuemin={0}
        className="sr-only"
        onKeyDown={keyDown}
        ref={control}
        role="separator"
        tabIndex={0}
      />
      {edges.map((edge) => (
        <div
          aria-hidden="true"
          data-chat-edge={edge}
          key={edge}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerDown={(event) => start(event, edge)}
          onPointerMove={move}
        />
      ))}
    </>
  );
}
