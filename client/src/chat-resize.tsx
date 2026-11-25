import { type KeyboardEvent, type RefObject, useId, useRef } from "react";

import { Icon } from "./icons";
import { useBoardUi } from "./ui";

export type ChatSize = { height?: number; width?: number };

type Drag = {
  pointer: number;
  rect: DOMRect;
  size: ChatSize;
  wide: boolean;
  x: number;
  y: number;
};

const STEP = 24;
const EXPAND = 120;
const DRAG_THRESHOLD = 4;

function adjust(size: ChatSize, rect: DOMRect, x: number, y: number): ChatSize {
  return {
    height: y === 0 ? size.height : Math.round(rect.height + y),
    width: x === 0 ? size.width : Math.round(rect.width + x),
  };
}

// Match the sheet's sm breakpoint, below which it spans the board.
const canResizeWidth = () => globalThis.matchMedia("(min-width: 40rem)").matches;

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
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rect = sheet.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const x = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    const y = event.key === "ArrowDown" ? -STEP : event.key === "ArrowUp" ? STEP : 0;
    if (y === 0 && (x === 0 || !canResizeWidth())) return;
    event.preventDefault();
    event.stopPropagation();
    change(adjust(size, rect, x, y));
  };

  return (
    <>
      <span className="sr-only" id={hint}>
        {copy.chatResizeHint}
      </span>
      <button
        aria-describedby={hint}
        aria-label={copy.chatResize}
        className="absolute top-0 left-1/2 grid size-11 -translate-x-1/2 touch-none cursor-ns-resize place-items-center rounded-full text-foreground-muted select-none hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus active:bg-bg-tertiary sm:static sm:translate-x-0 sm:cursor-nesw-resize"
        onClick={(event) => {
          if (event.detail !== 0 && dragged.current) return;
          const rect = sheet.current?.getBoundingClientRect();
          if (rect === undefined) return;
          const hasSize = size.height !== undefined || size.width !== undefined;
          change(hasSize ? {} : adjust(size, rect, canResizeWidth() ? EXPAND : 0, EXPAND));
        }}
        onKeyDown={onKeyDown}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          const rect = sheet.current?.getBoundingClientRect();
          if (rect === undefined) return;
          dragged.current = false;
          drag.current = {
            pointer: event.pointerId,
            rect,
            size,
            wide: canResizeWidth(),
            x: event.clientX,
            y: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null || start.pointer !== event.pointerId) return;
          const x = start.wide ? event.clientX - start.x : 0;
          const y = start.y - event.clientY;
          if (!dragged.current && Math.max(Math.abs(x), Math.abs(y)) < DRAG_THRESHOLD) return;
          dragged.current = true;
          // On desktop the sheet grows on both sides of its fixed horizontal centre.
          change(adjust(start.size, start.rect, x * 2, y));
        }}
        title={copy.chatResize}
        type="button"
      >
        <span aria-hidden="true" className="h-1 w-7 rounded-full bg-current sm:hidden" />
        <Icon className="hidden size-4 sm:block" name="Resize" />
      </button>
    </>
  );
}
