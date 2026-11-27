/** How a run of saves ended: whether the latest choice is saved, and what the server holds. */
export type Settled<Value> = { ok: boolean; saved: Value };

/**
 * Saves choices one request at a time. A choice made while a request is in
 * flight waits in a single slot, replacing any choice already waiting there,
 * so only the latest is sent next. A choice may also wait out a pause first,
 * which a newer choice restarts and `flush` cuts short. `waiting` tells
 * whether a choice has not been sent yet. `settle` runs once nothing is in
 * flight or waiting.
 */
export function latestWins<Value>({
  initial,
  save,
  settle,
}: {
  initial: Value;
  save: (value: Value) => Promise<boolean>;
  settle: (settled: Settled<Value>) => void;
}) {
  let saved = initial;
  let wanted = initial;
  let paused: { value: Value } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: { value: Value } | null = null;

  const run = async () => {
    while (wanted !== saved) {
      const target = wanted;
      sending = { value: target };
      const done = await save(target).catch(() => false);
      if (done) saved = target;
      else if (wanted === target) break;
    }
    sending = null;
    if (paused !== null) return;
    const ok = wanted === saved;
    wanted = saved;
    settle({ ok, saved });
  };

  const start = () => {
    clearTimeout(timer);
    if (paused !== null) wanted = paused.value;
    paused = null;
    if (sending === null) void run();
  };

  return {
    choose(value: Value, pauseMs = 0) {
      clearTimeout(timer);
      paused = { value };
      if (pauseMs > 0) timer = setTimeout(start, pauseMs);
      else start();
    },
    flush() {
      if (paused !== null) start();
    },
    waiting() {
      return paused !== null || (sending !== null && sending.value !== wanted);
    },
  };
}
