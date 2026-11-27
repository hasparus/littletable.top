import { describe, expect, it } from "vitest";

import { latestWins } from "../client/src/latest-wins";

type Level = "off" | "read" | "write";

/** A server whose answers the test gives, one request at a time. */
function server() {
  const sent: Level[] = [];
  const answers: ((saved: boolean) => void)[] = [];
  const save = (level: Level) => {
    sent.push(level);
    return new Promise<boolean>((resolve) => answers.push(resolve));
  };
  const answer = async (saved: boolean) => {
    await Promise.resolve();
    answers.shift()?.(saved);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { answer, save, sent };
}

describe("saving the latest access level", () => {
  it("keeps a saved level when the next one fails", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const first = queue.choose("read");
    await answer(true);
    expect(await first).toEqual({ ok: true, saved: "read" });
    const second = queue.choose("write");
    await answer(false);
    expect(await second).toEqual({ ok: false, saved: "read" });
    expect(sent).toEqual(["read", "write"]);
  });

  it("saves a level after an earlier one failed", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const first = queue.choose("read");
    await answer(false);
    expect(await first).toEqual({ ok: false, saved: "off" });
    const second = queue.choose("write");
    await answer(true);
    expect(await second).toEqual({ ok: true, saved: "write" });
    expect(sent).toEqual(["read", "write"]);
  });

  it("returns to the first level when it is chosen again while the second is in flight", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const run = queue.choose("read");
    expect(queue.choose("off")).toBeNull();
    await answer(true);
    await answer(true);
    expect(await run).toEqual({ ok: true, saved: "off" });
    expect(sent).toEqual(["read", "off"]);
  });

  it("sends only the last of the levels chosen while a request is in flight", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const run = queue.choose("read");
    for (const level of ["write", "off", "write"] as const) expect(queue.choose(level)).toBeNull();
    await answer(true);
    await answer(true);
    expect(await run).toEqual({ ok: true, saved: "write" });
    expect(sent).toEqual(["read", "write"]);
  });

  it("goes on to a newer level when the one in flight fails", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const run = queue.choose("read");
    queue.choose("write");
    await answer(false);
    await answer(true);
    expect(await run).toEqual({ ok: true, saved: "write" });
    expect(sent).toEqual(["read", "write"]);
  });

  it("counts a failed request as settled when the person chose the saved level again", async () => {
    const { answer, save, sent } = server();
    const queue = latestWins<Level>("off", save);
    const run = queue.choose("read");
    queue.choose("off");
    await answer(false);
    expect(await run).toEqual({ ok: true, saved: "off" });
    expect(sent).toEqual(["read"]);
  });

  it("sends nothing for the level that is already saved", async () => {
    const { save, sent } = server();
    const queue = latestWins<Level>("write", save);
    expect(await queue.choose("write")).toEqual({ ok: true, saved: "write" });
    expect(sent).toEqual([]);
  });

  it("treats a request that throws as a failure", async () => {
    const queue = latestWins<Level>("off", () => Promise.reject(new Error("offline")));
    expect(await queue.choose("read")).toEqual({ ok: false, saved: "off" });
  });
});
