import { useId, useRef, useState } from "react";

import type { Roll } from "./bootstrap";
import type { RollRefusal } from "./rolls";

import {
  MAX_EXPRESSION_LENGTH,
  MAX_MODIFIER,
  type NotationError,
  parseNotation,
  type RollRequest,
  rollResult,
} from "../../src/dice-notation";
import { DIE_SIDES, MAX_DICE } from "../../src/limits";
import { type Copy, dieLabel, fill } from "./copy";
import { useDialogBackdrop } from "./dialog";
import { modifierLabel, notationLabel, poolLabel } from "./dice-labels";
import { DieShape } from "./die-shape";
import { Icon } from "./icons";
import { Sheet } from "./sheet";
import { enterSurface } from "./surface-entry";
import { useBoardUi } from "./ui";

const DIE_BUTTON =
  "grid h-12 place-items-center rounded-xl transition-transform select-none touch-manipulation active:scale-95 disabled:opacity-40 hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus";

function LogEntry({ copy, locale, roll }: { copy: Copy; locale: string; roll: Roll }) {
  const { kept, notation, total } = rollResult(roll);
  const modifier = notation?.modifier ?? null;
  return (
    <li className="flex items-center gap-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <p className="flex min-w-0 max-w-full items-baseline gap-1.5 text-sm">
          <span className="truncate font-semibold">{roll.name}</span>
          <span className="min-w-0 wrap-break-word text-foreground-muted">
            {notation === null
              ? poolLabel(
                  copy,
                  roll.dice.map(({ sides }) => sides),
                )
              : notationLabel(copy, notation)}
          </span>
        </p>
        <p className="flex min-w-0 max-w-full flex-wrap gap-0.5">
          {roll.dice.map((die, index) => (
            <DieShape
              copy={copy}
              dropped={!kept[index]}
              key={index}
              sides={die.sides}
              size="xs"
              tone="quiet"
              value={die.value}
            />
          ))}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-base/5 font-bold tabular-nums">
          {modifier !== null && (
            <span className="mr-1 text-sm font-normal">{modifierLabel(modifier)} =</span>
          )}
          <span className="sr-only">{copy.total}: </span>
          {total}
        </p>
        <p className="text-xs/3 text-foreground-muted tabular-nums">
          {new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(roll.at)}
        </p>
      </div>
    </li>
  );
}

function RollLog() {
  const { copy, locale, rolls } = useBoardUi();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useDialogBackdrop(dialog);

  return (
    <>
      <div className="mt-4 border-t border-border pt-1">
        <button
          aria-haspopup="dialog"
          className="min-h-11 w-full rounded-lg px-2 text-left text-sm font-semibold text-foreground-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus"
          onClick={(event) => {
            const surface = dialog.current;
            if (surface === null) return;
            event.currentTarget.focus({ preventScroll: true });
            surface.showModal();
            surface.scrollTop = 0;
            enterSurface(surface, event.currentTarget);
          }}
          type="button"
        >
          {copy.rollLog}
        </button>
      </div>
      <dialog
        aria-labelledby={heading}
        className="fixed inset-0 m-auto max-h-[min(36rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-md overflow-y-auto overscroll-contain rounded-2xl bg-bg-secondary text-foreground shadow-sheet backdrop:bg-ink/30"
        data-roll-log
        ref={dialog}
      >
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg-secondary pr-1 pl-3">
          <h2 className="flex-1 text-base font-semibold" id={heading}>
            {copy.rollLog}
          </h2>
          <button
            aria-label={copy.close}
            className="grid size-11 place-items-center rounded-full text-foreground-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus"
            onClick={() => dialog.current?.close()}
            type="button"
          >
            <Icon name="Close" />
          </button>
        </header>
        {rolls.log.length === 0 ? (
          <p className="px-4 py-3 text-sm text-foreground-muted">{copy.noRollsYet}</p>
        ) : (
          <ol className="divide-y divide-border px-3 pb-1">
            {rolls.log.toReversed().map((entry) => (
              <LogEntry copy={copy} key={entry.id} locale={locale} roll={entry} />
            ))}
          </ol>
        )}
      </dialog>
    </>
  );
}

function notationMessage(copy: Copy, error: NotationError, example: string): string {
  switch (error) {
    case "count":
      return fill(copy.notationCount, { max: MAX_DICE });
    case "length":
      return fill(copy.notationLength, { max: MAX_EXPRESSION_LENGTH });
    case "modifier":
      return fill(copy.notationModifier, { max: MAX_MODIFIER });
    case "rule":
      return copy.notationRule;
    case "sides":
      return copy.notationSides;
    case "syntax":
      return fill(copy.notationSyntax, { example });
  }
}

/** Keep the primary roll control focused while the dice are in motion. */
export function DiceSheet() {
  const { close, copy, person, rollDraft, rolls, setRollDraft } = useBoardUi();
  const { expression, pool } = rollDraft;
  const expressionId = useId();
  const [busy, setBusy] = useState(false);
  const [notationError, setNotationError] = useState<NotationError | null>(null);
  const [refusal, setRefusal] = useState<RollRefusal | null>(null);
  const last = rolls.log.findLast(({ sub }) => sub === person.id);
  const hasExpression = expression.trim() !== "";
  const again = !hasExpression && pool.length === 0 && last !== undefined;
  const nextExpression = again ? last.expression : hasExpression ? expression : undefined;
  const nextPool = again ? last.dice.map(({ sides }) => sides) : pool;
  const notation = nextExpression === undefined ? null : parseNotation(nextExpression);
  const label =
    notation === null
      ? poolLabel(copy, nextPool)
      : typeof notation === "string"
        ? ""
        : notationLabel(copy, notation);
  const example = `3${dieLabel(copy, 6)}kh2 + 3`;

  const roll = async (request: RollRequest) => {
    setBusy(true);
    setRefusal(null);
    const answer = await rolls.roll(request);
    setBusy(false);
    setRefusal(answer);
    if (answer === null) {
      setRollDraft((current) => (current === rollDraft ? { expression: "", pool: [] } : current));
      close("dice");
    }
  };

  return (
    <Sheet panel="dice" title={copy.dice}>
      <div aria-live="polite" className="flex min-h-12 flex-wrap items-center gap-1.5">
        {pool.length === 0 ? (
          <p className="text-sm text-foreground-muted">{copy.poolEmpty}</p>
        ) : (
          <>
            {pool.map((sides, index) => (
              <button
                aria-label={fill(copy.removeDie, {
                  die: dieLabel(copy, sides),
                })}
                className="grid h-11 min-w-11 touch-manipulation place-items-center rounded-xl focus-visible:outline-2 focus-visible:outline-border-focus active:scale-95"
                key={index}
                onClick={() => setRollDraft({ expression, pool: pool.toSpliced(index, 1) })}
                type="button"
              >
                <DieShape copy={copy} sides={sides} tone="soft" />
              </button>
            ))}
            {pool.length > 1 && (
              <button
                className="ml-auto h-11 rounded-full px-3 text-sm text-foreground-secondary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
                onClick={() => setRollDraft({ expression, pool: [] })}
                type="button"
              >
                {copy.clearPool}
              </button>
            )}
          </>
        )}
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1.5">
        {DIE_SIDES.map((sides) => (
          <button
            aria-label={fill(copy.addDie, { die: dieLabel(copy, sides) })}
            className={DIE_BUTTON}
            disabled={pool.length >= MAX_DICE}
            key={sides}
            onClick={() => {
              setNotationError(null);
              setRollDraft({ expression: "", pool: [...pool, sides] });
            }}
            type="button"
          >
            <DieShape copy={copy} sides={sides} size="lg" tone="quiet" />
          </button>
        ))}
      </div>

      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (typeof notation === "string") {
            setNotationError(notation);
            setRefusal(null);
          } else if (nextExpression !== undefined) {
            void roll({ expression: nextExpression });
          } else if (nextPool.length > 0) {
            void roll({ dice: nextPool });
          }
        }}
      >
        <label className="block text-sm font-medium" htmlFor={expressionId}>
          {copy.diceExpression}
        </label>
        <input
          aria-describedby={notationError === null ? undefined : `${expressionId}-error`}
          aria-invalid={notationError !== null}
          autoCapitalize="none"
          autoComplete="off"
          className="mt-1 block h-11 w-full rounded-lg border border-border bg-bg-secondary px-3 text-base focus:border-primary focus:outline-none"
          enterKeyHint="go"
          id={expressionId}
          onChange={(event) => {
            const { value } = event.target;
            setRollDraft({ expression: value, pool: value.trim() === "" ? pool : [] });
            setNotationError(null);
          }}
          placeholder={example}
          spellCheck={false}
          value={expression}
        />
        {notationError !== null && (
          <p className="mt-2 text-sm text-danger-text" id={`${expressionId}-error`} role="status">
            {notationMessage(copy, notationError, example)}
          </p>
        )}
        <button
          aria-disabled={busy}
          className="btn btn-primary mt-3 min-h-12 w-full gap-2 aria-disabled:opacity-70"
          disabled={nextExpression === undefined && nextPool.length === 0}
          type="submit"
        >
          {again && <Icon className="size-4 shrink-0" name="Repeat" />}
          <span className="truncate">
            {again ? (
              fill(copy.rollAgain, { pool: label })
            ) : (
              <>
                {copy.roll}
                {label && <span className="font-normal"> {label}</span>}
              </>
            )}
          </span>
        </button>
      </form>
      {refusal !== null && (
        <p className="mt-2 text-sm text-danger-text" role="status">
          {refusal === "too-fast" ? copy.rollTooFast : copy.rollFailed}
        </p>
      )}

      <RollLog />
    </Sheet>
  );
}
