import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Roll } from "./bootstrap";
import type { Copy } from "./copy";
import type { DiceThrow } from "./dice-scene";
import type { RollRefusal, Rolls } from "./rolls";

import { type RollResult, rollResult } from "../../src/dice-notation";
import { dieLabel, fill } from "./copy";
import { modifierLabel } from "./dice-labels";
import { dropDice3d, isDice3dDown } from "./dice-stage-fallback";
import { DieShape } from "./die-shape";

// WARNING: A throw that never reports back must still reveal its result.
const GIVE_UP_MS = 12_000;
const GAP = 8;
const ROW_MIN_WIDTH = 120;
const WIDE_BOARD_WIDTH = 1024;
const NAME_MIN_WIDTH = 56;
const NAME_CLASS = "min-w-0 shrink truncate text-xs font-medium text-foreground-secondary";
const RESTING_AFTER_MS = 4000;

export type DiceStageProps = {
  copy: Copy;
  onRoll: Rolls["roll"];
  onSettled: () => void;
  roll: Roll;
};

const prefersStill = () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Overflow = "both" | "end" | "none" | "start";

function overflowOf(row: HTMLElement): Overflow {
  const hidden = row.scrollWidth - row.clientWidth;
  if (hidden < 1) return "none";
  const before = row.scrollLeft > 1;
  const after = row.scrollLeft < hidden - 1;
  if (before && after) return "both";
  return before ? "start" : "end";
}

const FADES: Record<Overflow, string> = {
  both: "mask-[linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)]",
  end: "mask-[linear-gradient(to_right,black_calc(100%-1rem),transparent)]",
  none: "",
  start: "mask-[linear-gradient(to_right,transparent,black_1rem)]",
};

type Place = {
  alignment: "below" | "beside" | "center";
  below: number;
  left: number;
  top: number;
  width: number;
};

const boxOf = (selector: string): DOMRect | null => {
  return (
    [...document.querySelectorAll(selector)]
      .map((element) => element.getBoundingClientRect())
      .find((box) => box.width > 0) ?? null
  );
};

function placeToast(height: number): Place {
  const zone = boxOf(".tlui-menu-zone") ?? new DOMRect();
  const button = boxOf("[data-testid='main-menu.button']") ?? zone;
  const publicControls = boxOf("[data-public-board-controls]");
  const secretToggle = boxOf("[data-secret-layer-toggle]");
  const viewportWidth = document.documentElement.clientWidth;
  const sideRight = Math.min(
    viewportWidth,
    ...[...document.querySelectorAll(".tlui-layout__top__right > *")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => box.left),
  );
  const right = Math.min(
    sideRight,
    publicControls?.left ?? sideRight,
    secretToggle?.left ?? sideRight,
  );
  const center = viewportWidth / 2;
  const centeredWidth = 2 * (Math.min(center - zone.right, right - center) - GAP);
  const centered = viewportWidth >= WIDE_BOARD_WIDTH && centeredWidth >= ROW_MIN_WIDTH;
  const besideWidth = right - zone.right - 2 * GAP;
  const beside = besideWidth >= ROW_MIN_WIDTH;
  const rowBottom = Math.max(zone.bottom, publicControls?.bottom ?? 0, secretToggle?.bottom ?? 0);
  const top = beside ? button.top + (button.height - height) / 2 : rowBottom + GAP;
  return {
    alignment: centered ? "center" : beside ? "beside" : "below",
    below: Math.max(rowBottom, top + height),
    left: centered ? center : beside ? zone.right + GAP : GAP,
    top: Math.round(top),
    width: centered ? centeredWidth : beside ? besideWidth : sideRight - 2 * GAP,
  };
}

const samePlace = (a: Place | null, b: Place) =>
  a !== null &&
  a.alignment === b.alignment &&
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.below === b.below;

const dropFrom = (place: Place): Keyframe[] => [
  { opacity: 0, transform: `translateY(${-Math.ceil(place.top + 24)}px)` },
  { opacity: 1, transform: "none" },
];

// WARNING: Measure dice and total independently of the name to avoid oscillating toast widths.
function nameFits(toast: HTMLElement, dice: HTMLElement, sum: HTMLElement | null, width: number) {
  const style = getComputedStyle(toast);
  const chrome = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
    .map((side) => Number.parseFloat(style[side as "paddingLeft"]))
    .reduce((all, one) => all + one, 0);
  const probe = document.createElement("span");
  probe.className = `${NAME_CLASS} invisible absolute`;
  probe.textContent = toast.dataset.roller ?? "";
  toast.append(probe);
  const name = probe.scrollWidth;
  probe.remove();
  const room = width - chrome - dice.scrollWidth - (sum === null ? 0 : sum.offsetWidth + GAP) - GAP;
  return room >= Math.min(name, NAME_MIN_WIDTH);
}

function ResultToast({
  copy,
  onClose,
  onPlace,
  result,
  roll,
  shown,
}: {
  copy: Copy;
  onClose: () => void;
  onPlace: (below: number) => void;
  result: RollResult;
  roll: Roll;
  shown: boolean;
}) {
  const toast = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLSpanElement>(null);
  const sum = useRef<HTMLSpanElement>(null);
  const [named, setNamed] = useState(false);
  const exiting = useRef<Animation | null>(null);
  const lastPlace = useRef<Place | null>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");
  const [place, setPlace] = useState<Place | null>(null);
  const [restedRoll, setRestedRoll] = useState<Roll | null>(null);
  const placed = place !== null;
  const resting = restedRoll === roll;
  const modifier = result.notation?.modifier ?? null;

  useEffect(() => {
    exiting.current?.cancel();
    exiting.current = null;
    if (!shown || lastPlace.current === null) return;
    const timer = setTimeout(() => setRestedRoll(roll), RESTING_AFTER_MS);
    if (!prefersStill()) {
      toast.current?.animate(dropFrom(lastPlace.current), {
        duration: 180,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      });
    }
    return () => clearTimeout(timer);
  }, [roll, shown, placed]);

  useLayoutEffect(() => {
    const element = toast.current;
    const dice = row.current;
    if (element === null || dice === null) return;
    const measure = () => {
      const next = placeToast(element.offsetHeight);
      if (!samePlace(lastPlace.current, next)) {
        lastPlace.current = next;
        setPlace(next);
        onPlace(next.below);
      }
      setNamed(nameFits(element, dice, sum.current, next.width));
      setOverflow(overflowOf(dice));
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(dice);
    for (const zone of document.querySelectorAll(
      ".tlui-menu-zone, .tlui-layout__top__right, [data-public-board-controls], [data-secret-layer-toggle]",
    )) {
      resized.observe(zone);
    }
    globalThis.addEventListener("resize", measure);
    return () => {
      resized.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [onPlace, roll]);

  const close = () => {
    if (exiting.current !== null) return;
    if (toast.current === null || place === null || prefersStill()) {
      onClose();
      return;
    }
    const exit = toast.current.animate(dropFrom(place).toReversed(), {
      duration: 140,
      easing: "cubic-bezier(0.55, 0, 1, 0.45)",
      fill: "forwards",
    });
    exiting.current = exit;
    void exit.finished.then(
      () => exiting.current === exit && onClose(),
      () => null,
    );
  };

  return (
    <button
      aria-label={copy.close}
      className={`group fixed z-60 flex h-9 items-center rounded-xl border border-border/60 bg-bg-secondary/90 px-2.5 text-foreground shadow-toast backdrop-blur-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus ${shown && placed ? "" : "invisible"}`}
      data-dice-toast={place?.alignment ?? "beside"}
      data-resting={resting ? "" : undefined}
      data-roller={roll.name}
      onClick={close}
      ref={toast}
      style={{
        left: place?.left ?? 0,
        maxWidth: place?.width,
        top: `max(${place?.top ?? 0}px, env(safe-area-inset-top))`,
        translate: place?.alignment === "center" ? "-50%" : undefined,
        width: place?.alignment === "center" ? "max-content" : undefined,
      }}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2 transition-opacity duration-700 group-data-resting:opacity-70 motion-reduce:transition-none">
        {named && <span className={NAME_CLASS}>{roll.name}</span>}
        <span
          className={`flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] ${FADES[overflow]}`}
          onScroll={(event) => setOverflow(overflowOf(event.currentTarget))}
          ref={row}
        >
          {roll.dice.map((die, index) => (
            <DieShape
              copy={copy}
              dropped={!result.kept[index]}
              key={index}
              sides={die.sides}
              size="xs"
              tone="soft"
              value={die.value}
            />
          ))}
        </span>
        {(roll.dice.length > 1 || modifier !== null || result.kept.includes(false)) && (
          <span
            className="shrink-0 border-l border-border pl-2 text-base leading-none font-bold tabular-nums"
            ref={sum}
          >
            {modifier !== null && (
              <span className="mr-1 text-xs font-normal">{modifierLabel(modifier)} =</span>
            )}
            {result.total}
          </span>
        )}
      </span>
    </button>
  );
}

/** Plays the received roll and calls onSettled when its result toast is dismissed. */
export function DiceStage({ copy, onRoll, onSettled, roll }: DiceStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const thrown = useRef<Promise<DiceThrow> | null>(null);
  const [settledId, setSettledId] = useState<number | null>(null);
  const [rowBottom, setRowBottom] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<{ id: number; reason: RollRefusal } | null>(null);
  const [, setFailures] = useState(0);
  const still = useMemo(() => prefersStill(), []);
  const result = useMemo(() => rollResult(roll), [roll]);
  const unavailable = isDice3dDown();
  const showToast = still || unavailable || settledId === roll.id;

  useEffect(() => {
    if (still || isDice3dDown() || host.current === null) return;
    const element = host.current;
    let current = true;
    const giveUpTimer = setTimeout(() => setSettledId(roll.id), GIVE_UP_MS);
    thrown.current ??= import("./dice-scene").then(({ createDiceThrow }) =>
      createDiceThrow(element, (error) => {
        dropDice3d(error);
        setFailures((count) => count + 1);
      }),
    );
    thrown.current
      .then(async (dice) => {
        if (!current) return;
        await dice.roll(roll.dice, {
          kept: result.kept,
          launch: roll.launch,
          nameDie: (index) =>
            fill(copy.rollDieAgain, { die: dieLabel(copy, roll.dice[index]!.sides) }),
          reroll: async (index, launch) => {
            setRefusal(null);
            const reason = await onRoll({ dice: [roll.dice[index]!.sides], launch });
            if (reason !== null && current) setRefusal({ id: roll.id, reason });
            return reason === null;
          },
          seed: roll.seed ?? roll.id,
        });
      })
      .then(() => current && setSettledId(roll.id))
      .catch((error: unknown) => {
        dropDice3d(error);
        if (current) setSettledId(roll.id);
      });
    return () => {
      current = false;
      clearTimeout(giveUpTimer);
    };
  }, [copy, onRoll, result, roll, still]);

  useEffect(
    () => () => {
      void thrown.current?.then(
        (dice) => dice.dispose(),
        () => null,
      );
      thrown.current = null;
    },
    [],
  );

  return (
    <>
      {!still && !unavailable && (
        <div
          className="pointer-events-none fixed inset-x-0 top-14 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10"
          ref={host}
          style={rowBottom === null ? undefined : { top: rowBottom + GAP }}
        />
      )}
      <ResultToast
        copy={copy}
        onClose={onSettled}
        onPlace={setRowBottom}
        result={result}
        roll={roll}
        shown={showToast}
      />
      {refusal?.id === roll.id && (
        <p
          className="pointer-events-none fixed z-60 rounded-lg bg-bg-secondary px-3 py-1.5 text-sm text-danger-text shadow-toast"
          role="status"
          style={{ left: GAP, top: (rowBottom ?? 48) + GAP }}
        >
          {refusal.reason === "too-fast" ? copy.rollTooFast : copy.rollFailed}
        </p>
      )}
    </>
  );
}
