import type { TLArrowBinding, TLGeoShape, TLRecord, TLShape } from "@tldraw/tlschema";

import { createTLSchema } from "@tldraw/tlschema";
import { describe, expect, it } from "vitest";

import { applyOps, type ApplyOpsResponse } from "../../src/mcp/board";
import { Doc } from "../../src/ops/doc";
import { intersects, pageBounds } from "../../src/ops/geometry";
import { freshBoard, seat, until } from "./support";

// apply_ops from the MCP Worker against a real board room in the board
// Worker, with nobody connected: tldraw's engine runs here on the stand-in
// editor over a snapshot, and the room commits the diff.

function board() {
  const b = freshBoard();
  return {
    ...b,
    apply: (ops: unknown[], extra: { page?: number | string; runId?: string } = {}) =>
      applyOps(b.room, b.grant, { ops, ...extra }),
  };
}

const applied = (response: ApplyOpsResponse) => {
  if (typeof response === "string" || response.kind !== "applied") {
    throw new Error(`not applied: ${JSON.stringify(response)}`);
  }
  return response.result;
};

const schema = createTLSchema();

function expectValid(records: TLRecord[]) {
  for (const record of records) {
    const type = (schema.types as Record<string, { validate: (r: unknown) => unknown }>)[
      record.typeName
    ]!;
    expect(() => type.validate(record)).not.toThrow();
  }
}

const shape = (records: TLRecord[], id: string) =>
  records.find((record) => record.id === `shape:${id}`) as TLShape | undefined;

describe("apply_ops on a board nobody has open", () => {
  it("runs all eleven ops", async () => {
    const b = board();
    const first = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "tavern", op: "add", text: "The Yawning Portal" },
        { at: { x: 380, y: 0 }, h: 120, id: "wall", kind: "box", op: "add", w: 120 },
        { id: "cellar", op: "add", relation: "right_of", target: "tavern", text: "Cellar" },
        {
          id: "note",
          kind: "note",
          op: "add",
          relation: "below",
          target: "tavern",
          text: "Rumour",
        },
        { from: "tavern", id: "stairs", op: "connect", text: "stairs", to: "cellar" },
        { id: "tag", op: "label", target: "wall", text: "Old wall" },
        { op: "rename", target: "cellar", text: "Wine cellar" },
        { color: "red", fill: "solid", op: "restyle", targets: ["wall"] },
        { h: 160, op: "resize", target: "wall", w: 160 },
        { at: { x: 0, y: 600 }, id: "copy", op: "duplicate", subject: "tavern", text: "Annex" },
        {
          id: "river",
          op: "path",
          points: [
            { x: 0, y: 900 },
            { x: 200, y: 950 },
            { x: 400, y: 900 },
          ],
          smooth: true,
        },
        { op: "place", relation: "below", subject: "copy", target: "note" },
        { op: "untangle", targets: ["tavern", "cellar", "wall", "note", "copy"] },
        { op: "remove", targets: ["tag"] },
      ]),
    );
    expect(first.errors).toEqual([]);
    expect(new Set(first.results.map((result) => result.op))).toEqual(
      new Set([
        "add",
        "connect",
        "duplicate",
        "label",
        "path",
        "place",
        "remove",
        "rename",
        "resize",
        "restyle",
        "untangle",
      ]),
    );
    const records = await b.records();
    expectValid(records);
    expect((shape(records, "wall") as TLGeoShape).props).toMatchObject({
      color: "red",
      fill: "solid",
      h: 160,
      w: 160,
    });
    expect(shape(records, "tag")).toBeUndefined();
    expect(shape(records, "river")).toMatchObject({ type: "line" });
    expect(shape(records, "tavern")!.meta).toMatchObject({ agent: { batchId: first.batchId } });
    const bindings = records.filter((r): r is TLArrowBinding => r.typeName === "binding");
    expect(bindings.map((binding) => [binding.props.terminal, binding.toId]).sort()).toEqual([
      ["end", "shape:cellar"],
      ["start", "shape:tavern"],
    ]);
    const doc = new Doc(records);
    const boxes = ["tavern", "cellar", "wall", "note", "copy"].map((id) =>
      pageBounds(doc, doc.shape(`shape:${id}`)!),
    );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(intersects(boxes[i]!, boxes[j]!), `${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it("reaches shapes made by earlier calls of the same run, and only those", async () => {
    const b = board();
    applied(await b.apply([{ at: { x: 0, y: 0 }, op: "add", text: "Act I" }], { runId: "plot" }));
    applied(
      await b.apply([{ at: { x: 400, y: 0 }, op: "add", text: "Act II" }], { runId: "plot" }),
    );
    const third = applied(
      await b.apply(
        [
          { from: { created: 0 }, op: "connect", to: { created: "last" } },
          { op: "rename", target: { created: 1 }, text: "Act II: the heist" },
        ],
        { runId: "plot" },
      ),
    );
    expect(third.errors).toEqual([]);
    const other = applied(
      await b.apply([{ op: "remove", targets: { created: "all" } }], { runId: "x" }),
    );
    expect((await b.records()).filter((record) => record.typeName === "shape")).toHaveLength(3);
    expect(other.results[0]).toMatchObject({ shapeIds: [] });
  });

  it("reports a failing op, rolls it back and applies the others; an invalid batch applies nothing", async () => {
    const b = board();
    const mixed = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "keep", op: "add", text: "Kept" },
        { op: "rename", target: "missing", text: "x" },
        { at: { x: 500, y: 0 }, id: "keep", op: "add", text: "Same id" },
        { at: { x: 0, y: 300 }, op: "add", text: "Also kept" },
      ]),
    );
    expect(mixed.results.map((result) => result.ok)).toEqual([true, false, false, true]);
    expect(mixed.errors).toEqual([
      'Op 1 (rename): Unknown shape "missing"',
      'Op 2 (add): Shape "keep" already exists; use a new id',
    ]);
    const before = await b.records();
    expect(before.filter((record) => record.typeName === "shape")).toHaveLength(2);

    const invalid = await b.apply([
      { at: { x: 0, y: 0 }, op: "add", text: "Never" },
      { op: "explode" },
    ]);
    expect(invalid).toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/^The batch is invalid and nothing was applied\./u),
    });
    expect(await b.records()).toEqual(before);
  });

  it("refuses a read-only grant and a revoked one", async () => {
    const b = board();
    const op = [{ at: { x: 0, y: 0 }, op: "add", text: "x" }];
    expect(await applyOps(b.room, { ...b.grant, access: "read" }, { ops: op })).toBe("read-only");
    await b.room.revokeMcpGrants(b.id, 3);
    expect(await applyOps(b.room, { ...b.grant, grant: 2 }, { ops: op })).toBe("revoked");
    expect(await applyOps(b.room, { ...b.grant, grant: 3 }, { ops: op })).toMatchObject({
      kind: "applied",
    });
  });

  it("works on the page it is given, by id, on a board with several", async () => {
    const b = board();
    const snapshot = await b.read();
    const second = { id: "page:two", index: "a2", meta: {}, name: "Dungeon", typeName: "page" };
    await b.room.commitDocument(b.grant, {
      absent: ["page:two"],
      puts: [second as TLRecord],
      removes: [],
      since: snapshot.clock,
      unchanged: [],
    });
    const result = applied(
      await b.apply([{ at: { x: 0, y: 0 }, id: "trap", op: "add", text: "Trap" }], {
        page: "page:two",
      }),
    );
    expect(result).toMatchObject({ errors: [], pageId: "page:two", pageName: "Dungeon" });
    expect(shape(await b.records(), "trap")).toMatchObject({ parentId: "page:two" });
    expect(await b.apply([{ op: "remove", targets: ["trap"] }], { page: 5 })).toMatchObject({
      kind: "no-page",
    });
  });

  it("sends the whole batch to a connected browser as one patch", async () => {
    const b = board();
    const person = await seat(b.id);
    const result = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "one", op: "add", text: "One" },
        { at: { x: 400, y: 0 }, id: "two", op: "add", text: "Two" },
        { from: "one", op: "connect", to: "two" },
      ]),
    );
    expect(result.errors).toEqual([]);
    const patches = () =>
      person.received
        .flatMap((message) =>
          message.type === "data" ? (message.data as { diff?: object; type: string }[]) : [message],
        )
        .filter((message) => message.type === "patch");
    await until(() => patches().length > 0);
    expect(patches()).toHaveLength(1);
    expect(Object.keys((patches()[0] as unknown as { diff: object }).diff)).toHaveLength(5);
  });
});
