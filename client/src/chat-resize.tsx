import { play } from "cuelume";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons";
import { PANEL_ID, useBoardUi } from "./ui";

export type ChatSize = { height?: number; width?: number; left?: number; bottom?: number };

const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof edges)[number];

type ResizeCue = { cursor: string } | { x: number; y: number };

function ChatResizeCue({ cue }: { cue: ResizeCue }) {
  return createPortal(
    "cursor" in cue ? (
      <div aria-hidden="true" className="fixed inset-0 z-60" style={{ cursor: cue.cursor }} />
    ) : (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-60 size-12 -translate-1/2 rounded-full border-2 border-[rgb(0_0_0/0.3)]"
        data-chat-touch-resize
        style={{ left: cue.x, top: cue.y }}
      >
        <span className="absolute top-0 right-0 grid size-5 place-items-center rounded-full bg-bg-secondary text-foreground">
          <Icon className="size-4" name="ResizeVertical" />
        </span>
      </div>
    ),
    document.body,
  );
}

type Drag = {
  edge: Edge;
  pointer: number;
  minWidth: number;
  rect: DOMRect;
  size: ChatSize;
  x: number;
  y: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const desktop = () => matchMedia("(min-width: 40rem)").matches;
const margin = 8;

export function useChatMove(
  sheet: RefObject<HTMLElement | null>,
  layout: { change: (size: ChatSize) => void; size: ChatSize } | undefined,
  keyboardArea: { bottom: number; height: number } | undefined,
) {
  const drag = useRef<{
    bottom: number;
    pointer: number;
    preferredSize: ChatSize;
    rect: DOMRect;
    x: number;
    y: number;
  } | null>(null);
  if (!layout) return;

  return {
    onPointerDown(event: PointerEvent<HTMLHeadingElement>) {
      if (!desktop() || !event.isPrimary || event.button !== 0 || drag.current || !sheet.current)
        return;
      event.preventDefault();
      const rect = sheet.current.getBoundingClientRect();
      drag.current = {
        bottom: innerHeight - rect.bottom,
        pointer: event.pointerId,
        preferredSize: layout.size,
        rect,
        x: event.clientX,
        y: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLHeadingElement>) {
      const from = drag.current;
      if (from?.pointer !== event.pointerId) return;
      const { rect } = from;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;
      const minBottom = keyboardArea?.bottom ?? margin;
      const availableHeight = keyboardArea?.height ?? innerHeight - 2 * margin;
      const left = clamp(rect.left + dx, margin, innerWidth - rect.width - margin);
      const bottom = clamp(
        from.bottom - dy,
        minBottom,
        minBottom + Math.max(0, availableHeight - rect.height),
      );
      layout.change({
        ...layout.size,
        left: dx === 0 || left === rect.left ? from.preferredSize.left : left,
        bottom: dy === 0 || bottom === from.bottom ? from.preferredSize.bottom : bottom,
      });
    },
    onLostPointerCapture(event: PointerEvent<HTMLHeadingElement>) {
      if (drag.current?.pointer === event.pointerId) drag.current = null;
    },
  };
}

function resize(
  size: ChatSize,
  rect: DOMRect,
  minWidth: number,
  edge: Edge,
  dx: number,
  dy: number,
) {
  const next = { ...size };
  if (desktop() && (edge.includes("e") || edge.includes("w"))) {
    const left = edge.includes("w")
      ? clamp(rect.left + dx, margin, rect.right - minWidth)
      : rect.left;
    const right = edge.includes("e")
      ? clamp(rect.right + dx, left + minWidth, innerWidth - margin)
      : rect.right;
    next.width = right - left;
    next.left = left;
    next.height = rect.height;
    next.bottom = innerHeight - rect.bottom;
  }
  if (edge.includes("n") || edge.includes("s")) {
    const minHeight = Math.min(144, rect.height);
    const top = edge.includes("n")
      ? clamp(rect.top + dy, margin, rect.bottom - minHeight)
      : rect.top;
    const bottom = edge.includes("s")
      ? clamp(rect.bottom + dy, top + minHeight, innerHeight - margin)
      : rect.bottom;
    if (top !== rect.top || bottom !== rect.bottom) {
      next.height = bottom - top;
      if (desktop()) next.bottom = innerHeight - bottom;
    }
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
  const [cue, setCue] = useState<ResizeCue | null>(null);

  useEffect(() => {
    const panel = sheet.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      panel.style.setProperty("--chat-measured-height", `${panel.offsetHeight}px`);
      control.current?.setAttribute("aria-valuenow", String(panel.offsetHeight));
      control.current?.setAttribute(
        "aria-valuetext",
        `${panel.offsetWidth} × ${panel.offsetHeight} px`,
      );
      control.current?.setAttribute("aria-valuemax", String(innerHeight));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [sheet]);

  function keyDown(event: KeyboardEvent) {
    const panel = sheet.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const minWidth = Number.parseFloat(getComputedStyle(panel).minWidth);
    const dx = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    const dy = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0;
    if (event.key === "Enter" || event.key === " ") {
      change(
        size.width !== undefined || size.height !== undefined
          ? {}
          : resize(size, rect, minWidth, "ne", 120, -120),
      );
    } else if (dy || (dx && desktop())) {
      change(resize(size, rect, minWidth, dy ? "n" : "e", dx, dy));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function start(event: PointerEvent<HTMLDivElement>, edge: Edge) {
    if (!event.isPrimary || event.button !== 0 || drag.current || !sheet.current) return;
    event.preventDefault();
    drag.current = {
      pointer: event.pointerId,
      minWidth: Number.parseFloat(getComputedStyle(sheet.current).minWidth),
      rect: sheet.current.getBoundingClientRect(),
      size,
      edge,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    control.current?.focus({ preventScroll: true });
    if (event.pointerType === "touch") {
      setCue({ x: event.clientX, y: event.clientY });
      play("select", { emphasis: "subtle", input: "touch" });
    } else {
      setCue({ cursor: getComputedStyle(event.currentTarget).cursor });
    }
  }

  function move(event: PointerEvent) {
    const from = drag.current;
    if (from?.pointer !== event.pointerId) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (event.pointerType === "touch") setCue({ x: event.clientX, y: event.clientY });
    change(resize(from.size, from.rect, from.minWidth, from.edge, dx, dy));
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
          onLostPointerCapture={(event) => {
            if (drag.current?.pointer !== event.pointerId) return;
            drag.current = null;
            setCue(null);
          }}
          onPointerDown={(event) => start(event, edge)}
          onPointerMove={move}
        />
      ))}
      {cue !== null && <ChatResizeCue cue={cue} />}
    </>
  );
}
