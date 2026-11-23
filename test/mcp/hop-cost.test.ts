import type { TLRecord } from "@tldraw/tlschema";

import { expect, it } from "vitest";

import { computeOps } from "../../src/mcp/board";
import { freshBoard } from "./support";

// What the hop between the two Workers costs on a large board. Not a
// check of behaviour; run it for the numbers in docs/mcp-design.md:
//
//   VITE_HOP_COST=1 aube run test -- --project mcp test/mcp/hop-cost.test.ts --disableConsoleIntercept

const WORDS = "goblin tavern dragon map session loot quest crypt torch hall gate tower".split(" ");
const SHAPES = 5_000;

function ops(page: number): object[] {
  const out: object[] = [];
  for (let i = 0; i < SHAPES / 2; i++) {
    const n = page * 10_000 + i;
    out.push({
      at: { x: (i % 50) * 260, y: Math.floor(i / 50) * 260 },
      id: `s${n}`,
      kind: i % 5 === 0 ? "note" : "box",
      op: "add",
      text: `${WORDS[i % 12]} ${WORDS[(i * 5) % 12]} ${i}`,
    });
  }
  return out;
}

// NOTE: workerd's clock stands still while code runs and moves on I/O, so
// only the awaited calls across the binding can be timed here.
async function timed<T>(label: string, run: () => Promise<T>, times = 5): Promise<T> {
  const spans: number[] = [];
  let result!: T;
  for (let index = 0; index < times; index++) {
    const started = Date.now();
    result = await run();
    spans.push(Date.now() - started);
  }
  spans.sort((a, b) => a - b);
  console.log(
    `${label}: median ${spans[spans.length >> 1]} ms (min ${spans[0]}, max ${spans.at(-1)})`,
  );
  return result;
}

const asked = (import.meta as unknown as { env: Record<string, string | undefined> }).env
  .VITE_HOP_COST;

it.skipIf(asked === undefined)(
  "the hop on a 5,000-shape board",
  async () => {
    const b = freshBoard();
    const pages: TLRecord[] = [
      { id: "page:page", index: "a1", meta: {}, name: "Page 1", typeName: "page" } as TLRecord,
      { id: "page:two", index: "a2", meta: {}, name: "Page 2", typeName: "page" } as TLRecord,
    ];
    let records = pages;
    for (const [index, page] of ["page:page", "page:two"].entries()) {
      const outcome = computeOps(records, { ops: ops(index).slice(0, 1_000), page }, []);
      if (outcome.kind !== "computed") throw new Error(outcome.message);
      let puts = outcome.puts;
      for (const from of [1_000, 2_000]) {
        const more = computeOps(pages, { ops: ops(index).slice(from, from + 1_000), page }, []);
        if (more.kind !== "computed") throw new Error(more.message);
        puts = [...puts, ...more.puts];
      }
      records = [...records, ...puts];
      for (let at = 0; at < puts.length; at += 500) {
        const snapshot = await b.read();
        const chunk = [
          ...(index === 1 && at === 0 ? [pages[1]!] : []),
          ...puts.slice(at, at + 500),
        ];
        expect(
          await b.room.commitDocument(b.grant, {
            absent: [],
            puts: chunk,
            removes: [],
            since: snapshot.clock,
            unchanged: [],
          }),
        ).toMatchObject({ kind: "committed" });
      }
    }
    const whole = await timed("read the whole document", () => b.read());
    console.log(
      `  ${whole.records.length} records, ${(JSON.stringify(whole.records).length / 1e6).toFixed(2)} MB as JSON`,
    );
    const one = await timed("read one page", async () =>
      b.room.readDocument(b.grant, { scope: { page: "page:two" } }),
    );
    if (one === "revoked") throw new Error("revoked");
    console.log(
      `  ${one.records.length} records, ${(JSON.stringify(one.records).length / 1e6).toFixed(2)} MB as JSON`,
    );

    const hundred = whole.records.filter((record) => record.typeName === "shape").slice(0, 100);
    let round = 0;
    await timed("commit a 100-record diff", async () => {
      const snapshot = await b.room.readDocument(b.grant, { scope: { page: "page:none" } });
      if (snapshot === "revoked") throw new Error("revoked");
      round++;
      const puts = hundred.map(
        (record) => ({ ...record, x: (record as { x: number }).x + round }) as TLRecord,
      );
      console.log(`  diff ${(JSON.stringify(puts).length / 1e3).toFixed(0)} KB as JSON`);
      const started = Date.now();
      const outcome = await b.room.commitDocument(b.grant, {
        absent: [],
        puts,
        removes: [],
        since: snapshot.clock,
        unchanged: hundred.map((r) => r.id),
      });
      console.log(`  the commit call alone: ${Date.now() - started} ms`);
      expect(outcome).toMatchObject({ kind: "committed" });
    });
    await timed(
      "commit that removes one shape (scans for references)",
      async () => {
        const snapshot = await b.read();
        const victim = snapshot.records.find((record) => record.typeName === "shape")!;
        const started = Date.now();
        await b.room.commitDocument(b.grant, {
          absent: [],
          puts: [],
          removes: [victim.id],
          since: snapshot.clock,
          unchanged: [victim.id],
        });
        console.log(`  the commit call alone: ${Date.now() - started} ms`);
      },
      3,
    );
  },
  300_000,
);
