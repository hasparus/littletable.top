import type { TLArrowBinding, TLGeoShape, TLRecord, TLShape } from "@tldraw/tlschema";

import { createTLSchema } from "@tldraw/tlschema";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { BoardRoom } from "../../src/board-room";
import type { BoardGrant } from "../../src/mcp/grant";
import type { ApplyOpsResponse } from "../../src/ops/board-ops";

import { Doc } from "../../src/ops/doc";
import { intersects, pageBounds } from "../../src/ops/geometry";
import { pass, seat, until } from "../support";

// apply_ops against a real board room with nobody connected: the engine
// reads the room's records and writes through its storage, as it will in
// production when nobody has the board open.

const rooms = (env as unknown as { BoardRoom: DurableObjectNamespace<BoardRoom> }).BoardRoom;

let boards = 0;
function board() {
  const id = `ops-${++boards}-${crypto.randomUUID().slice(0, 8)}`;
  const grant: BoardGrant = { access: "write", board: id, grant: 0, title: null };
  const room = rooms.get(rooms.idFromName(id));
  return {
    apply: async (ops: unknown[], extra: { page?: number | string; runId?: string } = {}) =>
      (await room.mcpApplyOps(grant, { ops, ...extra })) as ApplyOpsResponse,
    grant,
    id,
    records: async () => (await room.records()) as TLRecord[],
    room,
  };
}

const applied = (response: ApplyOpsResponse) => {
  if (response.kind !== "applied") throw new Error(`not applied: ${JSON.stringify(response)}`);
  return response.result;
};

const shapes = (records: TLRecord[]) => records.filter((r): r is TLShape => r.typeName === "shape");
const schema = createTLSchema();

function expectValid(records: TLRecord[]) {
  for (const record of records) {
    const type = (schema.types as Record<string, { validate: (r: unknown) => unknown }>)[
      record.typeName
    ]!;
    expect(() => type.validate(record)).not.toThrow();
  }
}

describe("apply_ops on a board nobody has open", () => {
  it("adds a box sized to its text, then one beside it that steps around a neighbour", async () => {
    const b = board();
    const first = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "tavern", op: "add", text: "The Yawning Portal" },
        { at: { x: 320, y: 0 }, h: 120, id: "wall", op: "add", w: 120 },
        { id: "cellar", op: "add", relation: "right_of", target: "tavern", text: "Cellar" },
      ]),
    );
    expect(first.errors).toEqual([]);
    expect(first.results.map((result) => result.ok)).toEqual([true, true, true]);
    expect(first.results[2]!.adjusted).toMatch(/keep clear/u);
    const records = await b.records();
    expectValid(records);
    const doc = new Doc(records);
    const placed = ["tavern", "wall", "cellar"].map((id) =>
      pageBounds(doc, doc.shape(`shape:${id}`)!),
    );
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      expect(intersects(placed[i]!, placed[j]!)).toBe(false);
    }
    // NOTE: the cellar keeps to the asked side: right of the tavern.
    expect(placed[2]!.x).toBeGreaterThanOrEqual(placed[0]!.x + placed[0]!.w);
    const tavern = doc.shape("shape:tavern") as TLGeoShape;
    expect(tavern.props).toMatchObject({ geo: "rectangle", growY: 0 });
    expect(tavern.meta).toMatchObject({ agent: { batchId: first.batchId } });
  });

  it("connects two shapes with a bound, labelled arrow above both", async () => {
    const b = board();
    const result = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "a", op: "add", text: "Village" },
        { at: { x: 500, y: 200 }, id: "b", kind: "ellipse", op: "add", text: "Dragon's lair" },
        { from: "a", id: "road", op: "connect", text: "two days", to: { text: "dragon's lair" } },
      ]),
    );
    expect(result.errors).toEqual([]);
    const records = await b.records();
    expectValid(records);
    const arrow = records.find((r) => r.id === "shape:road") as TLShape & {
      props: { richText: unknown };
    };
    expect(arrow).toMatchObject({ parentId: "page:page", type: "arrow" });
    const bindings = records.filter((r): r is TLArrowBinding => r.typeName === "binding");
    expect(bindings.map((binding) => [binding.props.terminal, binding.toId]).sort()).toEqual([
      ["end", "shape:b"],
      ["start", "shape:a"],
    ]);
    const indexOf = (id: string) => (records.find((r) => r.id === id) as TLShape).index;
    expect(indexOf("shape:road") > indexOf("shape:b")).toBe(true);
  });

  it("reaches shapes made by earlier calls of the same run", async () => {
    const b = board();
    applied(await b.apply([{ at: { x: 0, y: 0 }, op: "add", text: "Act I" }], { runId: "plot" }));
    applied(await b.apply([{ op: "add", text: "Act II" }], { runId: "plot" }));
    const third = applied(
      await b.apply(
        [
          { from: { created: 0 }, op: "connect", to: { created: "last" } },
          { op: "rename", target: { created: "last" }, text: "Act II: the heist" },
        ],
        { runId: "plot" },
      ),
    );
    expect(third.errors).toEqual([]);
    const elsewhere = applied(
      await b.apply([{ op: "remove", targets: [{ created: "last" }] }], { runId: "other" }),
    );
    expect(elsewhere.errors[0]).toMatch(/made no shapes/u);
  });

  it("reports a failing op and applies the others; an invalid batch applies nothing", async () => {
    const b = board();
    const mixed = applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "keep", op: "add", text: "Kept" },
        { op: "rename", target: "missing", text: "x" },
        { id: "keep", op: "add", text: "Same id" },
        { op: "untangle", targets: ["keep"] },
        { at: { x: 0, y: 300 }, op: "add", text: "Also kept" },
      ]),
    );
    expect(mixed.results.map((result) => result.ok)).toEqual([true, false, false, false, true]);
    expect(mixed.errors).toEqual([
      "Op 1 (rename): No shape on this page has the id missing.",
      "Op 2 (add): A shape with the id keep already exists; use a new id.",
      "Op 3 (untangle): untangle is not supported by this board yet; nothing was changed.",
    ]);
    expect(shapes(await b.records())).toHaveLength(2);

    const before = await b.records();
    const invalid = await b.apply([
      { at: { x: 0, y: 0 }, op: "add", text: "Never" },
      { op: "add", text: "x".repeat(6_000) },
    ]);
    expect(invalid).toMatchObject({ kind: "invalid" });
    expect((invalid as { message: string }).message).toMatch(
      /^The batch is invalid and nothing was applied/u,
    );
    expect(await b.records()).toEqual(before);
  });

  it("asks which shape is meant when text matches several", async () => {
    const b = board();
    applied(
      await b.apply([
        { at: { x: 0, y: 0 }, id: "g1", op: "add", text: "Goblin" },
        { at: { x: 300, y: 0 }, id: "g2", op: "add", text: "goblin" },
      ]),
    );
    const result = applied(await b.apply([{ op: "remove", targets: [{ text: "Goblin" }] }]));
    expect(result.errors[0]).toMatch(
      /^Op 0 \(remove\): 2 shapes have the text "Goblin": g1 \(geo at/u,
    );
  });

  it("grows a box to a longer label as tldraw would, and keeps an arrow whose end is removed", async () => {
    const b = board();
    applied(
      await b.apply([
        { at: { x: 0, y: 0 }, h: 80, id: "box", op: "add", text: "Door", w: 160 },
        { at: { x: 400, y: 0 }, id: "key", kind: "note", op: "add", text: "Key" },
        { from: "box", id: "link", op: "connect", to: "key" },
      ]),
    );
    const renamed = applied(
      await b.apply([
        {
          op: "rename",
          target: "box",
          text: "The iron door, locked, with a rusted keyhole and runes along its frame",
        },
        { op: "remove", targets: ["key"] },
      ]),
    );
    expect(renamed.errors).toEqual([]);
    const records = await b.records();
    expectValid(records);
    const box = records.find((r) => r.id === "shape:box") as TLGeoShape;
    expect(box.props.w).toBe(160);
    expect(box.props.growY).toBeGreaterThan(0);
    expect(records.some((r) => r.id === "shape:link")).toBe(true);
    expect(records.filter((r) => r.typeName === "binding")).toHaveLength(1);
    expect(renamed.results[1]!.message).toBe(
      "Removed 1 shape; 1 arrow end stays where the removed shape was.",
    );
  });

  it("refuses a read-only grant and a revoked one", async () => {
    const b = board();
    const op = [{ at: { x: 0, y: 0 }, op: "add", text: "x" }];
    expect(await b.room.mcpApplyOps({ ...b.grant, access: "read" }, { ops: op })).toBe("read-only");
    await b.room.revokeMcpGrants(b.id, 3);
    expect(await b.room.mcpApplyOps({ ...b.grant, grant: 2 }, { ops: op })).toBe("revoked");
    expect(await b.room.mcpApplyOps({ ...b.grant, grant: 3 }, { ops: op })).toMatchObject({
      kind: "applied",
    });
  });

  it("sends the whole batch to a connected browser as one patch", async () => {
    const b = board();
    const person = await seat(b.id, await pass({ board: b.id }));
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
    expect(Object.keys((patches()[0] as { diff: object }).diff)).toHaveLength(5);
  });
});
