import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Roll } from "./bootstrap";
import type { Copy } from "./copy";
import type { DiceThrow } from "./dice-scene";

import { total } from "./dice";
import { dropDice3d, isDice3dDown } from "./dice-stage-fallback";
import { DieShape } from "./die-shape";

// NOTE: a throw that never reports back must not hide the result for good.
const GIVE_UP_MS = 12_000;
// Between the card and the tray, in CSS pixels.
const CARD_GAP = 8;

export type DiceStageProps = {
  copy: Copy;
  onSettled: () => void;
  roll: Roll;
};

const prefersStill = () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The card is laid out from the moment the roll arrives, so the tray below
// it has its final place before the dice fly; it shows once they settle.
function ResultCard({
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
  const card = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shown || prefersStill()) return;
    card.current?.animate(
      [
        { opacity: 0, transform: "translateY(-8px) scale(0.97)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
  }, [shown]);

  useLayoutEffect(() => {
    const element = card.current;
    if (element === null) return;
    const measure = () => onResize(element.getBoundingClientRect().bottom);
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    globalThis.addEventListener("resize", measure);
    return () => {
      resized.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [onResize]);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(4.5rem,calc(env(safe-area-inset-top)+3.5rem))] z-60 flex justify-center px-4">
      <button
        aria-label={copy.close}
        className={`flex w-full max-w-sm items-center gap-2.5 rounded-2xl bg-bg-secondary/95 px-3 py-2 text-foreground shadow-[0_8px_28px_rgb(37_34_32/0.24)] ring-1 ring-border backdrop-blur-sm focus-visible:outline-2 focus-visible:outline-border-focus ${shown ? "pointer-events-auto" : "invisible"}`}
        onClick={onClose}
        ref={card}
        type="button"
      >
        <span className="max-w-[42%] min-w-14 shrink-0 truncate text-left text-sm font-semibold">
          {roll.name}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
          {roll.dice.map((die, index) => (
            <DieShape copy={copy} key={index} sides={die.sides} size="sm" value={die.value} />
          ))}
        </span>
        {roll.dice.length > 1 && (
          <span className="min-w-8 shrink-0 border-l border-border pl-2.5 text-xl leading-none font-bold tabular-nums">
            {total(roll)}
          </span>
        )}
      </button>
    </div>
  );
}

// Throws a roll that just arrived for everyone at the board, on a tray that
// sits between the card and the bottom bar, and lands the dice on `roll`'s
// values. The card names who rolled and gives the total once they settle.
// The dice and the card stay until the next roll or a tap on the card, which
// calls `onSettled`.
export function DiceStage({ copy, onSettled, roll }: DiceStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const thrown = useRef<Promise<DiceThrow> | null>(null);
  const [settledId, setSettledId] = useState<number | null>(null);
  const [cardBottom, setCardBottom] = useState<number | null>(null);
  const [, setFailures] = useState(0);
  const still = useMemo(prefersStill, []);
  const unavailable = isDice3dDown();
  const showCard = still || unavailable || settledId === roll.id;

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
          className="pointer-events-none fixed inset-x-0 top-32 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10"
          ref={host}
          style={cardBottom === null ? undefined : { top: cardBottom + CARD_GAP }}
        />
      )}
      <ResultCard
        copy={copy}
        onClose={onSettled}
        onResize={setCardBottom}
        roll={roll}
        shown={showCard}
      />
    </>
  );
}
