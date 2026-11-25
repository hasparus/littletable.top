import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RollRequest } from "../../src/dice-notation";
import type { PassKeeper, Roll } from "./bootstrap";

import { EXPRESSION_ERRORS, type ExpressionError } from "../../src/dice-expression";

const LOG_LENGTH = 50;

export type RollRefusal = ExpressionError | "failed" | "too-fast";

export type Rolls = {
  arrived: Roll | null;
  log: Roll[];
  receive: (message: unknown) => void;
  roll: (roll: RollRequest) => Promise<RollRefusal | null>;
  settle: () => void;
};

const isRollMessage = (message: unknown): message is { roll: Roll; type: "roll" } =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "roll" &&
  typeof (message as { roll?: { id?: unknown } }).roll?.id === "number";

export function useRolls(keeper: PassKeeper): Rolls {
  const [log, setLog] = useState<Roll[]>([]);
  const [arrived, setArrived] = useState<Roll | null>(null);
  const seen = useRef(new Set<number>());

  // WARNING: A roll can arrive through the response, a room message, and the log. Keep each ID only once.
  const add = useCallback((rolls: Roll[], announce: boolean) => {
    const fresh = rolls.filter(({ id }) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const { id } of fresh) seen.current.add(id);
    setLog((current) => [...current, ...fresh].toSorted((a, b) => a.id - b.id).slice(-LOG_LENGTH));
    if (announce) setArrived(fresh.at(-1)!);
  }, []);

  const request = useCallback(
    async (path: string, init: RequestInit = {}) =>
      fetch(`${keeper.room}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${await keeper.pass()}`, ...init.headers },
      }),
    [keeper],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await request("/rolls");
        if (cancelled) return;
        if (response.status === 403) return keeper.end("link-reset");
        if (!response.ok) throw new Error(`status ${response.status}`);
        add((await response.json()) as Roll[], false);
      } catch (error) {
        console.error("board: roll log did not load", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [add, keeper, request]);

  const roll = useCallback(
    async (roll: RollRequest): Promise<RollRefusal | null> => {
      try {
        const response = await request("/roll", {
          body: JSON.stringify(roll),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (response.status === 429) return "too-fast";
        if (response.status === 403) {
          keeper.end("link-reset");
          return null;
        }
        if (response.status === 400 && "expression" in roll) {
          const body: { error?: unknown } | null = await response.json().catch(() => null);
          return EXPRESSION_ERRORS.find((error) => error === body?.error) ?? "failed";
        }
        if (!response.ok) throw new Error(`status ${response.status}`);
        add([(await response.json()) as Roll], true);
        return null;
      } catch (error) {
        console.error("board: roll failed", error);
        return "failed";
      }
    },
    [add, keeper, request],
  );

  const receive = useCallback(
    (message: unknown) => {
      if (isRollMessage(message)) add([message.roll], true);
    },
    [add],
  );
  const settle = useCallback(() => setArrived(null), []);

  return useMemo(
    () => ({ arrived, log, receive, roll, settle }),
    [arrived, log, receive, roll, settle],
  );
}
