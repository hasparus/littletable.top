import { type PointerEvent, useRef, useState } from "react";

import { MAX_TRACKER_SEATS, type TrackerControls } from "./tracker-controls";
import "./spotlight-rail.css";

const stop = (event: PointerEvent) => event.stopPropagation();

export function SpotlightRail({
  seats,
  active,
  select,
  rename,
  add,
  remove,
  readonly,
  locale,
  token,
}: TrackerControls) {
  const rail = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [hoveredSeat, setHoveredSeat] = useState<number | null>(null);
  const polish = locale === "pl";
  const activeIndex = seats.findIndex((seat) => seat.id === active);
  const markerIndex = seats.findIndex((seat) => seat.id === (hoveredSeat ?? active));

  function pointedSeat(event: PointerEvent<HTMLButtonElement>) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const row = target?.closest<HTMLElement>("[data-spotlight-strip]");
    if (row && rail.current?.contains(row)) return Number(row.dataset.spotlightStrip);
    if (target?.closest("[data-spotlight-marker]")) return hoveredSeat;
    return null;
  }

  function drop(event: PointerEvent<HTMLButtonElement>) {
    stop(event);
    if (dragging.current !== event.pointerId) return;
    const seat = pointedSeat(event);
    dragging.current = null;
    setHoveredSeat(null);
    if (seat !== null) select(seat);
  }

  return (
    <div data-spotlight-rail="" ref={rail}>
      <div data-spotlight-seats="">
        <div data-spotlight-track="" aria-hidden="true" />
        {seats.map((seat) => (
          <div key={seat.id} data-spotlight-strip={seat.id} data-active={seat.id === active}>
            <button
              type="button"
              data-spotlight-seat=""
              disabled={readonly}
              onPointerDown={stop}
              onPointerUp={stop}
              onClick={() => select(seat.id)}
              aria-pressed={seat.id === active}
              aria-label={polish ? `Wskaż: ${seat.name}` : `Spotlight ${seat.name}`}
            >
              <span aria-hidden="true" />
            </button>
            <input
              key={seat.name}
              type="text"
              data-spotlight-name=""
              aria-label={polish ? "Imię uczestnika" : "Participant name"}
              defaultValue={seat.name}
              readOnly={readonly}
              maxLength={48}
              onPointerDown={stop}
              onPointerUp={stop}
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
                data-spotlight-remove=""
                aria-label={polish ? `Usuń: ${seat.name}` : `Remove ${seat.name}`}
                onPointerDown={stop}
                onPointerUp={stop}
                onClick={() => remove(seat.id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {activeIndex !== -1 && (
          <div
            data-spotlight-position=""
            style={{ top: `${((Math.max(0, markerIndex) + 0.5) / seats.length) * 100}%` }}
          >
            <button
              type="button"
              data-spotlight-marker=""
              disabled={readonly}
              aria-label={polish ? "Przesuń reflektor" : "Move spotlight marker"}
              onPointerDown={(event) => {
                stop(event);
                if (!event.isPrimary || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragging.current = event.pointerId;
              }}
              onPointerMove={(event) => {
                if (dragging.current === event.pointerId) setHoveredSeat(pointedSeat(event));
              }}
              onPointerUp={drop}
              onLostPointerCapture={() => {
                dragging.current = null;
                setHoveredSeat(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.stopPropagation();
                event.preventDefault();
                const next = seats[activeIndex + (event.key === "ArrowUp" ? -1 : 1)];
                if (next) select(next.id);
              }}
            >
              {token && <img src={token} alt="" draggable={false} />}
            </button>
          </div>
        )}
      </div>
      {!readonly && (
        <button
          data-spotlight-add=""
          type="button"
          aria-label={polish ? "Dodaj uczestnika" : "Add participant"}
          onPointerDown={stop}
          onPointerUp={stop}
          disabled={seats.length >= MAX_TRACKER_SEATS}
          onClick={add}
        >
          +
        </button>
      )}
    </div>
  );
}
