import { type CSSProperties, type PointerEvent, useRef, useState } from "react";

import {
  MAX_TRACKER_SEATS,
  SPOTLIGHT_STEP,
  spotlightLevel,
  type TrackerControls,
  type TrackerSeat,
} from "./tracker-controls";
import "./spotlight-sliders.css";

function contain(event: PointerEvent) {
  event.stopPropagation();
}

function Fader({
  seat,
  readonly,
  polish,
  rename,
  remove,
  setValue,
}: {
  seat: TrackerSeat;
  readonly: boolean;
  polish: boolean;
  rename: (name: string) => void;
  remove?: () => void;
  setValue: (value: number) => void;
}) {
  const pointer = useRef<{ id: number; value: number } | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const marks = draft ?? spotlightLevel(seat.marks);

  function release(event: PointerEvent<HTMLInputElement>) {
    contain(event);
    if (pointer.current?.id !== event.pointerId) return;
    const { value } = pointer.current;
    pointer.current = null;
    setDraft(null);
    if (value !== spotlightLevel(seat.marks)) setValue(value);
  }

  function cancel() {
    pointer.current = null;
    setDraft(null);
  }

  return (
    <div data-spotlight-fader="">
      <input
        key={seat.name}
        data-spotlight-fader-name=""
        type="text"
        aria-label={polish ? "Imię uczestnika" : "Participant name"}
        defaultValue={seat.name}
        readOnly={readonly}
        maxLength={48}
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
          const next = event.currentTarget.value.trim();
          if (next && next !== seat.name) rename(next);
          else event.currentTarget.value = seat.name;
        }}
      />
      <div data-spotlight-fader-throw="">
        <input
          type="range"
          min="0"
          max="100"
          step={SPOTLIGHT_STEP}
          value={marks}
          disabled={readonly}
          aria-label={polish ? `Poziom: ${seat.name}` : `Level for ${seat.name}`}
          onPointerDown={(event) => {
            contain(event);
            pointer.current = { id: event.pointerId, value: marks };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={release}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (pointer.current) {
              pointer.current.value = value;
              setDraft(value);
            } else {
              setValue(value);
            }
          }}
        />
      </div>
      <div data-spotlight-fader-foot="">
        <span aria-hidden="true">{marks}</span>
        {remove && (
          <button
            type="button"
            aria-label={polish ? `Usuń: ${seat.name}` : `Remove ${seat.name}`}
            onPointerDown={contain}
            onPointerUp={contain}
            onClick={remove}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

export function SpotlightSliders({
  seats,
  rename,
  add,
  remove,
  setValue,
  readonly,
  locale,
  token,
}: TrackerControls) {
  const polish = locale === "pl";
  const canRemove = !readonly && seats.length > 1;
  const style: (CSSProperties & { "--spotlight-cap": string }) | undefined = token
    ? { "--spotlight-cap": `url("${token}")` }
    : undefined;
  return (
    <div data-spotlight-sliders="" style={style}>
      <div data-spotlight-faders="" onWheel={(event) => event.stopPropagation()}>
        {seats.map((seat) => (
          <Fader
            key={seat.id}
            seat={seat}
            readonly={readonly}
            polish={polish}
            rename={(name) => rename(seat.id, name)}
            remove={canRemove ? () => remove(seat.id) : undefined}
            setValue={(value) => setValue(seat.id, value)}
          />
        ))}
      </div>
      <div data-spotlight-fader-side="">
        {!readonly && (
          <button
            type="button"
            aria-label={polish ? "Dodaj uczestnika" : "Add participant"}
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
