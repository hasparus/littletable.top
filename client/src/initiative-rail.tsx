import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";

import { MAX_TRACKER_SEATS, type TrackerControls } from "./tracker-controls";
import "./initiative-rail.css";

type Drag = { id: number; pointer: number; x: number; y: number; moved: boolean };

function contain(event: PointerEvent) {
  event.stopPropagation();
}

export function InitiativeRail({
  seats,
  active,
  select,
  rename,
  add,
  remove,
  reorder,
  readonly,
  locale,
  portraits = [],
}: TrackerControls) {
  const line = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const [target, setTarget] = useState<number | null>(null);
  const polish = locale === "pl";
  const current = seats.findIndex((seat) => seat.id === active);

  useLayoutEffect(() => {
    const scroller = line.current;
    const visible = scroller?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!scroller || !visible) return;
    const segment = visible.parentElement;
    if (!segment) return;
    const start = segment.offsetLeft;
    const end = start + segment.offsetWidth;
    if (start < scroller.scrollLeft) scroller.scrollLeft = start;
    else if (end > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = end - scroller.clientWidth;
    }
  }, [active, current]);

  function grab(event: PointerEvent<HTMLButtonElement>, id: number) {
    contain(event);
    if (!event.isPrimary || event.button !== 0) return;
    dragged.current = false;
    drag.current = {
      id,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function targetAt(event: PointerEvent<HTMLButtonElement>) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const portrait = element?.closest<HTMLElement>("[data-initiative-segment]");
    if (portrait && line.current?.contains(portrait))
      return Number(portrait.dataset.initiativeSegment);
    return null;
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    const travel = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (travel < 5 && !start.moved) return;
    start.moved = true;
    setTarget(targetAt(event));
  }

  function clear() {
    drag.current = null;
    setTarget(null);
  }

  function release(event: PointerEvent<HTMLButtonElement>) {
    contain(event);
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    const destination = targetAt(event);
    dragged.current = start.moved;
    clear();
    if (start.moved && destination !== null && start.id !== destination) {
      reorder(start.id, destination);
    }
  }

  return (
    <div data-initiative-rail="">
      <div data-initiative-line="" ref={line} onWheel={(event) => event.stopPropagation()}>
        {seats.map((seat, index) => {
          const art = portraits[seat.id % portraits.length];
          return (
            <div
              data-initiative-segment={seat.id}
              data-initiative-target={seat.id === target || undefined}
              key={seat.id}
            >
              <button
                type="button"
                data-portrait={seat.id}
                disabled={readonly}
                aria-current={seat.id === active || undefined}
                aria-keyshortcuts="ArrowLeft ArrowRight"
                aria-label={polish ? `Tura: ${seat.name}` : `Turn for ${seat.name}`}
                onPointerDown={(event) => grab(event, seat.id)}
                onPointerMove={move}
                onPointerUp={release}
                onLostPointerCapture={clear}
                onClick={(event) => {
                  if (event.detail === 0 || !dragged.current) select(seat.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.stopPropagation();
                  event.preventDefault();
                  const sibling = seats[index + (event.key === "ArrowLeft" ? -1 : 1)];
                  if (sibling) reorder(seat.id, sibling.id);
                }}
              >
                {art ? (
                  <img src={art} alt="" draggable={false} />
                ) : (
                  <span aria-hidden="true">{seat.name.slice(0, 2)}</span>
                )}
              </button>
              <input
                key={seat.name}
                type="text"
                aria-label={polish ? "Imię postaci" : "Character name"}
                defaultValue={seat.name}
                maxLength={48}
                readOnly={readonly}
                onPointerDown={contain}
                onPointerUp={contain}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.currentTarget.value = seat.name;
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name && name !== seat.name) rename(seat.id, name);
                  else event.currentTarget.value = seat.name;
                }}
              />
              {!readonly && seats.length > 1 && (
                <button
                  type="button"
                  data-initiative-remove=""
                  aria-label={polish ? `Usuń: ${seat.name}` : `Remove ${seat.name}`}
                  onPointerDown={contain}
                  onPointerUp={contain}
                  onClick={() => remove(seat.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div data-initiative-actions="">
        <button
          type="button"
          aria-label={polish ? "Następna tura" : "Next turn"}
          title={polish ? "Następna tura" : "Next turn"}
          disabled={readonly || seats.length < 2}
          onPointerDown={contain}
          onPointerUp={contain}
          onClick={() => {
            const next = seats[(current + 1) % seats.length];
            if (next) select(next.id);
          }}
        >
          →
        </button>
        {!readonly && (
          <button
            type="button"
            aria-label={polish ? "Dodaj postać" : "Add character"}
            onPointerDown={contain}
            onPointerUp={contain}
            disabled={seats.length >= MAX_TRACKER_SEATS}
            onClick={add}
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}
