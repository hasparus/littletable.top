import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Roll } from "./bootstrap";
import type { Copy } from "./copy";
import type { DiceThrow } from "./dice-scene";
import type { RollRefusal, Rolls } from "./rolls";

import { type RollResult, rollResult } from "../../src/dice-notation";
import { dieLabel, fill } from "./copy";
import { modifierLabel } from "./dice";
import { dropDice3d, isDice3dDown } from "./dice-stage-fallback";
import { DieShape } from "./die-shape";

// NOTE: a throw that never reports back must not hide the result for good.
const GIVE_UP_MS = 12_000;
// Between the toast, tldraw's controls, the screen's edge and the tray, in
// CSS pixels.
const GAP = 8;
// Narrower than this beside the menu, the toast drops below it instead.
const ROW_MIN_WIDTH = 120;
// The dice and the total come first: the roller's name shows only where
// every die fits beside it and the name keeps this much of itself (or all
// of a shorter one). The roll log and the announcement always give it.
const NAME_MIN_WIDTH = 56;
const NAME_CLASS = "min-w-0 shrink truncate text-xs font-medium text-foreground-secondary";
// How long the result reads at full contrast before it steps back.
const RESTING_AFTER_MS = 4000;

export type DiceStageProps = {
  copy: Copy;
  onRoll: Rolls["roll"];
  onSettled: () => void;
  roll: Roll;
};

const prefersStill = () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Overflow = "both" | "end" | "none" | "start";

// Which ends of the dice row hide dice, so only those fade.
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

type Place = { below: number; beside: boolean; left: number; top: number; width: number };

const boxOf = (selector: string): DOMRect | null => {
  const box = document.querySelector(selector)?.getBoundingClientRect();
  return box === undefined || box.width === 0 ? null : box;
};

// Beside tldraw's top-left controls (the main menu, and the page menu on a
// board of several pages), centred on the menu button, up to the controls
// tldraw keeps at the top right of a wide screen, or the screen's edge.
// Where that row is too narrow, below the controls instead. `below` is
// where the toast and the controls end, for the tray.
function placeBesideMenu(height: number): Place {
  const zone = boxOf(".tlui-menu-zone") ?? new DOMRect();
  const button = boxOf("[data-testid='main-menu.button']") ?? zone;
  const publicControls = boxOf("[data-public-board-controls]");
  const sideRight = Math.min(
    document.documentElement.clientWidth,
    ...[...document.querySelectorAll(".tlui-layout__top__right > *")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => box.left),
  );
  const right = Math.min(sideRight, publicControls?.left ?? sideRight);
  const besideWidth = right - zone.right - 2 * GAP;
  const beside = besideWidth >= ROW_MIN_WIDTH;
  const rowBottom = Math.max(zone.bottom, publicControls?.bottom ?? 0);
  const top = beside ? button.top + (button.height - height) / 2 : rowBottom + GAP;
  return {
    below: Math.max(rowBottom, top + height),
    beside,
    left: beside ? zone.right + GAP : GAP,
    top: Math.round(top),
    width: beside ? besideWidth : sideRight - 2 * GAP,
  };
}

const samePlace = (a: Place | null, b: Place) =>
  a !== null &&
  a.beside === b.beside &&
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.below === b.below;

// From just above the screen's top edge.
const dropFrom = (place: Place): Keyframe[] => [
  { opacity: 0, transform: `translateY(${-Math.ceil(place.top + 24)}px)` },
  { opacity: 1, transform: "none" },
];

// Whether the roller's name fits beside every die and the total in a toast
// of `width`: the dice row's and the total's own widths do not depend on
// the name, so the answer does not flip once the name comes or goes.
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

// The toast is laid out from the moment the roll arrives, so the tray below
// it has its final place before the dice fly; it drops in once they settle.
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
  const [resting, setResting] = useState(false);
  const placed = place !== null;
  const modifier = result.notation?.modifier ?? null;

  useEffect(() => {
    // A newer roll takes the toast over from one on its way out.
    exiting.current?.cancel();
    exiting.current = null;
    setResting(false);
    if (!shown || lastPlace.current === null) return;
    const timer = setTimeout(() => setResting(true), RESTING_AFTER_MS);
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
      const next = placeBesideMenu(element.offsetHeight);
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
      ".tlui-menu-zone, .tlui-layout__top__right, [data-public-board-controls]",
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
      // NOTE: cancelled only when a newer roll took the toast over.
      () => null,
    );
  };

  return (
    <button
      aria-label={copy.close}
      className={`group fixed z-60 flex h-9 items-center rounded-xl border border-border/60 bg-bg-secondary/90 px-2.5 text-foreground shadow-toast backdrop-blur-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus ${shown && placed ? "" : "invisible"}`}
      data-dice-toast={place?.beside === false ? "below" : "beside"}
      data-resting={resting ? "" : undefined}
      data-roller={roll.name}
      onClick={close}
      ref={toast}
      style={{
        left: place?.left ?? 0,
        maxWidth: place?.width,
        top: `max(${place?.top ?? 0}px, env(safe-area-inset-top))`,
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

// Throws a roll that just arrived for everyone at the board, on a tray that
// sits between the top row and the bottom bar, and lands the dice on `roll`'s
// values. The toast names who rolled and gives the total once they settle.
// The dice and the toast stay until the next roll or a tap on the toast,
// which calls `onSettled`.
export function DiceStage({ copy, onRoll, onSettled, roll }: DiceStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const thrown = useRef<Promise<DiceThrow> | null>(null);
  const [settledId, setSettledId] = useState<number | null>(null);
  const [rowBottom, setRowBottom] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<{ id: number; reason: RollRefusal } | null>(null);
  const [, setFailures] = useState(0);
  const still = useMemo(prefersStill, []);
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
      // NOTE: a roll logged before seeds existed never arrives live; its id
      // stands in so that every screen would still throw alike.
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
      // A scene that never came to be has nothing to dispose of.
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
