/** How a run of saves ended: whether the latest choice is saved, and what the server holds. */
export type Settled<Value> = { ok: boolean; saved: Value };

/**
 * Saves choices one request at a time. A choice made while a request is in
 * flight waits in a single slot, replacing any choice already waiting there,
 * so only the latest is sent next. A run settles once, when nothing newer
 * waits; `choose` returns that settlement to the caller that started the run
 * and `null` to callers whose choice joined it.
 */
export function latestWins<Value>(initial: Value, save: (value: Value) => Promise<boolean>) {
  let saved = initial;
  let wanted = initial;
  let running: Promise<Settled<Value>> | null = null;

  const run = async () => {
    while (wanted !== saved) {
      const target = wanted;
      const done = await save(target).catch(() => false);
      if (done) saved = target;
      else if (wanted === target) break;
    }
    running = null;
    const ok = wanted === saved;
    wanted = saved;
    return { ok, saved };
  };

  return {
    choose(value: Value) {
      wanted = value;
      if (running !== null) return null;
      if (wanted === saved) return Promise.resolve({ ok: true, saved });
      running = run();
      return running;
    },
  };
}
