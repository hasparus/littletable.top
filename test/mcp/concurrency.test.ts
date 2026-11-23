import type { TLGeoShape, TLRecord, TLShape } from "@tldraw/tlschema";

import { describe, expect, it } from "vitest";

import type { RoomDocumentCalls } from "../../src/room-document";

import { applyOps, type ApplyOpsResponse, MAX_ATTEMPTS } from "../../src/mcp/board";
import { Doc } from "../../src/ops/doc";
import { pageBounds } from "../../src/ops/geometry";
import { freshBoard } from "./support";

// Someone edits the board between the MCP Worker's snapshot and its commit.
// The edits here go through the room as a person's would (a write the batch
// did not make), timed by wrapping the room's read.

type Board = ReturnType<typeof freshBoard>;

const applied = (response: ApplyOpsResponse) => {
  if (typeof response === "string" || response.kind !== "applied") {
    throw new Error(`not applied: ${JSON.stringify(response)}`);
  }
  return response;
};

// The room, with `meanwhile` run after each snapshot is taken and before
// the caller sees it: the moment a concurrent edit does the most harm.
function interleaved(b: Board, meanwhile: (read: number) => Promise<void>): RoomDocumentCalls {
  let reads = 0;
  return {
    commitDocument: (grant, diff) => b.room.commitDocument(grant, diff),
    readDocument: async (grant, request) => {
      const snapshot = await b.room.readDocument(grant, request);
      await meanwhile(++reads);
      return snapshot;
    },
    revokeMcpGrants: (board, version) => b.room.revokeMcpGrants(board, version),
  };
}

// A person's edit: whatever they change, written on top of the room as it is.
async function edit(
  b: Board,
  change: (records: TLRecord[]) => { puts?: TLRecord[]; removes?: string[] },
) {
  const snapshot = await b.read();
  const { puts = [], removes = [] } = change(snapshot.records);
  const outcome = await b.room.commitDocument(b.grant, {
    absent: [],
    puts,
    removes,
    since: snapshot.clock,
    unchanged: [],
  });
  expect(outcome).toMatchObject({ kind: "committed" });
}

const shape = (records: TLRecord[], id: string) =>
  records.find((record) => record.id === `shape:${id}`) as TLShape;

const moved = (id: string, x: number, y: number) => (records: TLRecord[]) => ({
  puts: [{ ...shape(records, id), x, y }],
});

async function seeded() {
  const b = freshBoard();
  applied(
    await applyOps(b.room, b.grant, {
      ops: [
        { at: { x: 0, y: 0 }, h: 100, id: "inn", op: "add", text: "Inn", w: 200 },
        { at: { x: 2_000, y: 2_000 }, h: 100, id: "far", op: "add", text: "Far away", w: 200 },
      ],
    }),
  );
  return b;
}

const beside = [{ id: "stable", op: "add", relation: "right_of", target: "inn", text: "Stable" }];

describe("a batch computed while people edit the board", () => {
  it("applies at once when the edit is to a shape it does not rest on", async () => {
    const b = await seeded();
    const room = interleaved(b, () => edit(b, moved("far", 2_500, 2_500)));
    const response = applied(await applyOps(room, b.grant, { ops: beside }));
    expect(response.attempts).toBe(1);
    const records = await b.records();
    expect(shape(records, "far")).toMatchObject({ x: 2_500, y: 2_500 });
    expect(shape(records, "stable")).toMatchObject({ x: 240 });
  });

  it("is computed again when the shape it was placed beside has moved", async () => {
    const b = await seeded();
    const room = interleaved(b, async (read) => {
      if (read === 1) await edit(b, moved("inn", 1_000, 500));
    });
    const response = applied(await applyOps(room, b.grant, { ops: beside }));
    expect(response.attempts).toBe(2);
    const doc = new Doc(await b.records());
    const inn = pageBounds(doc, doc.shape("shape:inn")!);
    const stable = pageBounds(doc, doc.shape("shape:stable")!);
    expect(stable.x).toBe(inn.x + inn.w + 40);
    expect(shape(await b.records(), "inn")).toMatchObject({ x: 1_000, y: 500 });
  });

  it("does not overwrite a label someone changed under a rename", async () => {
    const b = await seeded();
    const room = interleaved(b, async (read) => {
      if (read !== 1) return;
      await edit(b, (records) => {
        const inn = shape(records, "inn") as TLGeoShape;
        return { puts: [{ ...inn, props: { ...inn.props, color: "red" } } as TLRecord] };
      });
    });
    const response = applied(
      await applyOps(room, b.grant, { ops: [{ op: "rename", target: "inn", text: "The Inn" }] }),
    );
    expect(response.attempts).toBe(2);
    const inn = shape(await b.records(), "inn") as TLGeoShape;
    expect(inn.props.color).toBe("red");
    expect(JSON.stringify(inn.props.richText)).toContain("The Inn");
  });

  it("reports the op as failed, on the second look, when its target was deleted meanwhile", async () => {
    const b = await seeded();
    const room = interleaved(b, async (read) => {
      if (read === 1) await edit(b, () => ({ removes: ["shape:inn"] }));
    });
    const response = applied(
      await applyOps(room, b.grant, {
        ops: [...beside, { at: { x: 0, y: 600 }, id: "kept", op: "add", text: "Kept" }],
      }),
    );
    expect(response.attempts).toBe(2);
    expect(response.result.errors).toEqual(["Op 0 (add): No shape on this page has the id inn."]);
    const records = await b.records();
    expect(shape(records, "stable")).toBeUndefined();
    expect(shape(records, "kept")).toBeDefined();
  });

  it("takes along an arrow someone bound to a shape it removes", async () => {
    const b = await seeded();
    const room = interleaved(b, async (read) => {
      if (read !== 1) return;
      applied(
        await applyOps(b.room, b.grant, {
          ops: [{ from: "far", id: "road", op: "connect", to: "inn" }],
        }),
      );
    });
    const response = applied(
      await applyOps(room, b.grant, { ops: [{ op: "remove", targets: ["inn"] }] }),
    );
    expect(response.attempts).toBe(2);
    const records = await b.records();
    expect(shape(records, "inn")).toBeUndefined();
    expect(shape(records, "road")).toBeDefined();
    const dangling = records.filter(
      (record) => record.typeName === "binding" && record.toId === "shape:inn",
    );
    expect(dangling).toEqual([]);
  });

  it("gives up after a bounded number of attempts and changes nothing", async () => {
    const b = await seeded();
    let x = 0;
    const room = interleaved(b, () => edit(b, moved("inn", (x += 10), 0)));
    const response = await applyOps(room, b.grant, { ops: beside });
    expect(response).toEqual({
      kind: "busy",
      message: `People kept changing the shapes this batch touches (${MAX_ATTEMPTS} attempts); nothing was applied. Send it again, or in smaller batches.`,
    });
    expect(x).toBe(10 * MAX_ATTEMPTS);
    expect(shape(await b.records(), "stable")).toBeUndefined();
  });

  it("refuses a diff naming an id that was taken meanwhile, and one with an invalid record", async () => {
    const b = await seeded();
    const snapshot = await b.read();
    const inn = shape(snapshot.records, "inn");
    const base = { puts: [], removes: [], since: snapshot.clock, unchanged: [] };
    expect(await b.room.commitDocument(b.grant, { ...base, absent: ["shape:inn"] })).toEqual({
      kind: "conflict",
      records: ["shape:inn"],
      why: "exists",
    });
    const broken = { ...inn, id: "shape:broken", x: "left" } as unknown as TLRecord;
    expect(
      await b.room.commitDocument(b.grant, { ...base, absent: [], puts: [broken] }),
    ).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/^shape:broken: /u),
    });
    expect(await b.records()).toEqual(snapshot.records);
  });
});
