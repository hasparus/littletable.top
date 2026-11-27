import { afterEach, describe, expect, it, vi } from "vitest";

import { latestWins, type Settled } from "../client/src/latest-wins";

type Level = "off" | "read" | "write";

const drain = async () => {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
};

/** A server whose answers the test gives, one request at a time. */
function server(initial: Level = "off") {
  const sent: Level[] = [];
  const settled: Settled<Level>[] = [];
  const answers: ((saved: boolean) => void)[] = [];
  const queue = latestWins<Level>({
    initial,
    save: (level) => {
      sent.push(level);
      return new Promise<boolean>((resolve) => answers.push(resolve));
    },
    settle: (outcome) => settled.push(outcome),
  });
  const answer = async (saved: boolean) => {
    answers.shift()?.(saved);
    await drain();
  };
  return { answer, queue, sent, settled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("saving the latest access level", () => {
  it("keeps a saved level when the next one fails", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    await answer(true);
    queue.choose("write");
    await answer(false);
    expect(sent).toEqual(["read", "write"]);
    expect(settled).toEqual([
      { ok: true, saved: "read" },
      { ok: false, saved: "read" },
    ]);
  });

  it("saves a level after an earlier one failed", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    await answer(false);
    queue.choose("write");
    await answer(true);
    expect(sent).toEqual(["read", "write"]);
    expect(settled).toEqual([
      { ok: false, saved: "off" },
      { ok: true, saved: "write" },
    ]);
  });

  it("returns to the first level when it is chosen again while the second is in flight", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    queue.choose("off");
    await answer(true);
    await answer(true);
    expect(sent).toEqual(["read", "off"]);
    expect(settled).toEqual([{ ok: true, saved: "off" }]);
  });

  it("sends only the last of the levels chosen while a request is in flight", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    for (const level of ["write", "off", "write"] as const) queue.choose(level);
    await answer(true);
    await answer(true);
    expect(sent).toEqual(["read", "write"]);
    expect(settled).toEqual([{ ok: true, saved: "write" }]);
  });

  it("goes on to a newer level when the one in flight fails", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    queue.choose("write");
    await answer(false);
    await answer(true);
    expect(sent).toEqual(["read", "write"]);
    expect(settled).toEqual([{ ok: true, saved: "write" }]);
  });

  it("counts a failed request as settled when the person chose the saved level again", async () => {
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    queue.choose("off");
    await answer(false);
    expect(sent).toEqual(["read"]);
    expect(settled).toEqual([{ ok: true, saved: "off" }]);
  });

  it("sends nothing for the level that is already saved", () => {
    const { queue, sent, settled } = server("write");
    queue.choose("write");
    expect(sent).toEqual([]);
    expect(settled).toEqual([{ ok: true, saved: "write" }]);
  });

  it("treats a request that throws as a failure", async () => {
    const settled: Settled<Level>[] = [];
    const queue = latestWins<Level>({
      initial: "off",
      save: () => Promise.reject(new Error("offline")),
      settle: (outcome) => settled.push(outcome),
    });
    queue.choose("read");
    await drain();
    expect(settled).toEqual([{ ok: false, saved: "off" }]);
  });
});

describe("pausing a choice before it is saved", () => {
  it("sends a paused choice only when its pause ends", () => {
    vi.useFakeTimers();
    const { queue, sent } = server();
    queue.choose("read", 500);
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    expect(queue.waiting()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["read"]);
    expect(queue.waiting()).toBe(false);
  });

  it("restarts the pause for a newer choice and sends only that one", () => {
    vi.useFakeTimers();
    const { queue, sent } = server();
    queue.choose("read", 500);
    vi.advanceTimersByTime(300);
    queue.choose("write", 500);
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(sent).toEqual(["write"]);
  });

  it("sends a paused choice at once when flushed, and only once", () => {
    vi.useFakeTimers();
    const { queue, sent } = server();
    queue.choose("write", 500);
    queue.flush();
    expect(sent).toEqual(["write"]);
    vi.advanceTimersByTime(500);
    queue.flush();
    expect(sent).toEqual(["write"]);
  });

  it("lets an immediate choice replace a paused one", () => {
    vi.useFakeTimers();
    const { queue, sent } = server();
    queue.choose("write", 500);
    queue.choose("read");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["read"]);
  });

  it("settles once, after a choice paused behind a request in flight is saved", async () => {
    vi.useFakeTimers();
    const { answer, queue, sent, settled } = server();
    queue.choose("read");
    queue.choose("write", 500);
    await answer(true);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(["read", "write"]);
    await answer(true);
    expect(settled).toEqual([{ ok: true, saved: "write" }]);
  });

  it("still waits after a flush when a request is in flight", async () => {
    vi.useFakeTimers();
    const { answer, queue, sent } = server();
    queue.choose("read");
    queue.choose("write", 500);
    queue.flush();
    expect(queue.waiting()).toBe(true);
    await answer(true);
    expect(sent).toEqual(["read", "write"]);
    expect(queue.waiting()).toBe(false);
  });
});
