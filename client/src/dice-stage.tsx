import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Roll } from "./bootstrap";
import type { Copy } from "./copy";
import type { DiceThrow } from "./dice-scene";

import { total } from "./dice";
import { dropDice3d, isDice3dDown } from "./dice-stage-fallback";
import { DieShape } from "./die-shape";

// NOTE: a throw that never reports back must not hide the result for good.
const GIVE_UP_MS = 12_000;
// Between the strip and the tray, in CSS pixels.
const STRIP_GAP = 8;
// How long the result reads at full contrast before it steps back.
const RESTING_AFTER_MS = 4000;

const ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateY(-4px)" },
  { opacity: 1, transform: "none" },
];

export type DiceStageProps = {
  copy: Copy;
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
  both: "mask-[linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)]",
  end: "mask-[linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]",
  none: "",
  start: "mask-[linear-gradient(to_right,transparent,black_1.25rem)]",
};

// The strip is laid out from the moment the roll arrives, so the tray below
// it has its final place before the dice fly; it shows once they settle.
// While it shows, tldraw's top corner steps below it (board.css).
function ResultStrip({
  copy,
  onClose,
  onResize,
  roll,
  shown,
}: {
  copy: Copy;
  onClose: () => void;
  onResize: (bottom: number) => void;
  roll: Roll;
  shown: boolean;
}) {
  const strip = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLSpanElement>(null);
  const exiting = useRef<Animation | null>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");
  const [resting, setResting] = useState(false);

  useEffect(() => {
    // A newer roll takes the strip over from one on its way out.
    exiting.current?.cancel();
    exiting.current = null;
    setResting(false);
    if (!shown) return;
    const timer = setTimeout(() => setResting(true), RESTING_AFTER_MS);
    if (!prefersStill()) {
      strip.current?.animate(ENTER, { duration: 160, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }
    return () => clearTimeout(timer);
  }, [roll, shown]);

  useLayoutEffect(() => {
    const element = strip.current;
    const dice = row.current;
    if (element === null || dice === null) return;
    const measure = () => {
      onResize(element.getBoundingClientRect().bottom);
      setOverflow(overflowOf(dice));
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    resized.observe(dice);
    globalThis.addEventListener("resize", measure);
    return () => {
      resized.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [onResize, roll]);

  const close = () => {
    if (exiting.current !== null) return;
    if (strip.current === null || prefersStill()) {
      onClose();
      return;
    }
    const exit = strip.current.animate(ENTER.toReversed(), {
      duration: 120,
      easing: "ease-in",
      fill: "forwards",
    });
    exiting.current = exit;
    void exit.finished.then(
      () => exiting.current === exit && onClose(),
      // NOTE: cancelled only when a newer roll took the strip over.
      () => null,
    );
  };

  return (
    <button
      aria-label={copy.close}
      className={`group fixed inset-x-0 top-0 z-60 block border-b border-border/70 bg-bg-secondary/85 pt-[env(safe-area-inset-top)] text-foreground backdrop-blur-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus ${shown ? "" : "invisible"}`}
      data-dice-strip={shown ? "" : undefined}
      data-resting={resting ? "" : undefined}
      onClick={close}
      ref={strip}
      type="button"
    >
      <span className="flex h-(--dice-strip) items-center gap-2 px-3 sm:justify-center transition-opacity duration-700 group-data-resting:opacity-70 motion-reduce:transition-none">
        <span className="max-w-[35%] shrink-0 truncate text-xs font-medium text-foreground-secondary">
          {roll.name}
        </span>
        <span
          className={`flex min-w-0 gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] ${FADES[overflow]}`}
          onScroll={(event) => setOverflow(overflowOf(event.currentTarget))}
          ref={row}
        >
          {roll.dice.map((die, index) => (
            <DieShape
              copy={copy}
              key={index}
              sides={die.sides}
              size="xs"
              tone="soft"
              value={die.value}
            />
          ))}
        </span>
        {roll.dice.length > 1 && (
          <span className="shrink-0 border-l border-border pl-2 text-base leading-none font-bold tabular-nums">
            {total(roll)}
          </span>
        )}
      </span>
    </button>
  );
}

// Throws a roll that just arrived for everyone at the board, on a tray that
// sits between the strip and the bottom bar, and lands the dice on `roll`'s
// values. The strip names who rolled and gives the total once they settle.
// The dice and the strip stay until the next roll or a tap on the strip,
// which calls `onSettled`.
export function DiceStage({ copy, onSettled, roll }: DiceStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const thrown = useRef<Promise<DiceThrow> | null>(null);
  const [settledId, setSettledId] = useState<number | null>(null);
  const [stripBottom, setStripBottom] = useState<number | null>(null);
  const [, setFailures] = useState(0);
  const still = useMemo(prefersStill, []);
  const unavailable = isDice3dDown();
  const showStrip = still || unavailable || settledId === roll.id;

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
      .then(async (dice) => (current ? dice.roll(roll.dice, roll.seed ?? roll.id) : undefined))
      .then(() => current && setSettledId(roll.id))
      .catch((error: unknown) => {
        dropDice3d(error);
        if (current) setSettledId(roll.id);
      });
    return () => {
      current = false;
      clearTimeout(giveUpTimer);
    };
  }, [roll, still]);

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
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-12 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10"
          ref={host}
          style={stripBottom === null ? undefined : { top: stripBottom + STRIP_GAP }}
        />
      )}
      <ResultStrip
        copy={copy}
        onClose={onSettled}
        onResize={setStripBottom}
        roll={roll}
        shown={showStrip}
      />
    </>
  );
}
