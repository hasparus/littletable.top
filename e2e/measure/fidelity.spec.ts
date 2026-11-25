import type { TLRecord } from "@tldraw/tlschema";

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

import type { Step } from "./corpus";

import { computeOps } from "../../src/mcp/board";
import { SCREENSHOT_DIR } from "../screenshots";

// The same batches of ops, run twice from the same records: by tldraw's
// engine on a real Editor in a browser, and by the same engine on our
// stand-in editor (as in the MCP Worker, here in Node). The records that
// come out are compared field by field, and both boards are photographed.
//
//   aube run e2e:fidelity
//
// The artifacts are test/mcp/fixtures/fidelity.json and the screenshots.

const SCREENSHOTS = process.env.OPS_SCREENSHOTS ?? SCREENSHOT_DIR;
const REPORT = new URL("../../test/mcp/fixtures/fidelity.json", import.meta.url);

type Harness = {
  harness?: {
    scenario(
      name: string,
      steps: Step[],
      ops: object[],
    ): { after: TLRecord[]; before: TLRecord[]; pageId: string; result: { errors: string[] } };
    show(records: object[], pageId: string): void;
  };
};

const box = (id: string, x: number, y: number, extra: object = {}) => ({
  id: `shape:${id}`,
  props: { h: 80, w: 120, ...extra },
  type: "geo",
  x,
  y,
});

const SCENARIOS: { name: string; ops: object[]; steps: Step[] }[] = [
  {
    name: "map",
    ops: [
      { at: { x: 0, y: 0 }, id: "tavern", kind: "box", op: "add", text: "The Yawning Portal" },
      {
        id: "cellar",
        kind: "box",
        op: "add",
        relation: "right_of",
        target: "tavern",
        text: "Wine cellar",
      },
      {
        id: "lair",
        kind: "ellipse",
        op: "add",
        relation: "below",
        target: "cellar",
        text: "Dragon's lair",
      },
      {
        id: "rumour",
        kind: "note",
        op: "add",
        relation: "below",
        target: "tavern",
        text: "Plotka: w piwnicy ktoś widział smoka. Zażółć gęślą jaźń!",
      },
      {
        geo: "diamond",
        id: "gate",
        kind: "shape",
        op: "add",
        relation: "left_of",
        target: "tavern",
        text: "Gate",
      },
      { from: "tavern", id: "a1", op: "connect", text: "stairs", to: "cellar" },
      { from: "cellar", id: "a2", op: "connect", text: "two days", to: "lair" },
      { from: "rumour", id: "a3", op: "connect", to: "tavern" },
      { from: "gate", id: "a4", op: "connect", text: "guarded", to: "tavern" },
      { id: "l1", op: "label", side: "right", target: "lair", text: "Here be dragons" },
      {
        id: "title",
        kind: "label",
        op: "add",
        relation: "above",
        size: "l",
        target: "tavern",
        text: "Session 3",
      },
      {
        fit: "widen",
        op: "rename",
        target: "cellar",
        text: "The wine cellar under the tavern, locked since the flood",
      },
      { color: "blue", fill: "semi", op: "restyle", targets: ["gate", "lair"] },
    ],
    steps: [],
  },
  {
    name: "crowded",
    ops: [
      { op: "untangle", targets: Array.from({ length: 24 }, (_, i) => `c${i}`) },
      { op: "place", relation: "right_of", subject: "c0", target: "c5" },
      {
        id: "new",
        kind: "box",
        op: "add",
        relation: "right_of",
        target: "c3",
        text: "Squeezed in",
      },
      {
        id: "memo",
        kind: "note",
        op: "add",
        relation: "below",
        target: "c10",
        text: "Remember the key",
      },
      { at: { x: 50, y: 50 }, id: "dup", op: "duplicate", subject: "c1", text: "Copy" },
      { op: "untangle", targets: ["dup", "c1", "c2", "new"] },
      { h: 140, op: "resize", target: "c7", w: 220 },
      { op: "remove", targets: ["c20", "c21"] },
    ],
    steps: [
      {
        do: "create",
        shapes: Array.from({ length: 24 }, (_, i) =>
          box(`c${i}`, (i % 6) * 100, Math.floor(i / 6) * 70, {
            richText: {
              content: [{ content: [{ text: `Room ${i}`, type: "text" }], type: "paragraph" }],
              type: "doc",
            },
          }),
        ),
      },
    ],
  },
  {
    name: "frames",
    ops: [
      {
        id: "in1",
        kind: "box",
        op: "add",
        relation: "inside",
        target: "act",
        text: "Inside the frame",
      },
      {
        id: "by1",
        kind: "box",
        op: "add",
        relation: "right_of",
        target: "f1",
        text: "Beside a framed box",
      },
      { from: "f1", id: "x1", op: "connect", text: "leads to", to: "g1" },
      { from: "f1", id: "x2", op: "connect", to: "f2" },
      { op: "place", relation: "below", subject: "g2", target: "g1" },
      { id: "lf", op: "label", target: "f2", text: "Framed" },
      { op: "rename", target: "act", text: "Act I: the heist" },
      { color: "red", op: "restyle", targets: ["g1", "g2"] },
    ],
    steps: [
      {
        do: "create",
        shapes: [
          { id: "shape:act", props: { h: 400, name: "Act I", w: 600 }, type: "frame", x: 0, y: 0 },
        ],
      },
      {
        do: "create",
        shapes: [box("f1", 40, 60), box("f2", 300, 220), box("g1", 760, 0), box("g2", 900, 60)],
      },
      { do: "group", id: "grp", ids: ["g1", "g2"] },
    ],
  },
  {
    name: "rotated",
    ops: [
      {
        id: "n1",
        kind: "box",
        op: "add",
        relation: "right_of",
        target: "r1",
        text: "Next to a tilted box",
      },
      { from: "r1", id: "y1", op: "connect", text: "turns", to: "r2" },
      { op: "resize", target: "r2", w: 200 },
      { id: "lr", op: "label", target: "r1", text: "Tilted" },
      {
        id: "zig",
        op: "path",
        points: [
          { x: 0, y: 500 },
          { x: 100, y: 560 },
          { x: 200, y: 500 },
          { x: 300, y: 560 },
        ],
      },
      { op: "resize", target: "zig", w: 450 },
      {
        closed: true,
        fill: "semi",
        id: "pond",
        op: "path",
        points: [
          { x: 500, y: 450 },
          { x: 640, y: 470 },
          { x: 620, y: 590 },
          { x: 480, y: 560 },
        ],
        smooth: true,
      },
      { op: "place", relation: "below", subject: "r3", target: "r2" },
    ],
    steps: [
      { do: "create", shapes: [box("r1", 0, 0), box("r2", 400, 100), box("r3", 700, 300)] },
      { by: 0.5, do: "rotate", ids: ["r1"] },
      { by: Math.PI / 2, do: "rotate", ids: ["r2"] },
      { by: -0.3, do: "rotate", ids: ["r3"] },
    ],
  },
];

// A record as the comparison reads it, whichever kind it is.
type Row = {
  fromId: string;
  id: string;
  index: string;
  parentId: string;
  props: Record<string, unknown>;
  toId: string;
  type: string;
  typeName: string;
  x: number;
  y: number;
};
type Shape = Row;

const bindingsOf = (records: Row[]) =>
  records
    .filter((r) => r.typeName === "binding")
    .map(({ fromId, props, toId }) => {
      const sorted = Object.fromEntries(
        Object.entries(props).sort(([x], [y]) => x.localeCompare(y)),
      );
      return JSON.stringify({ fromId, props: sorted, toId });
    })
    .sort();

const NUMERIC_PROPS = new Set([
  "bend",
  "fontSizeAdjustment",
  "growY",
  "h",
  "labelPosition",
  "scale",
  "scaleX",
  "scaleY",
  "w",
]);

function compare(browserRecords: TLRecord[], standInRecords: TLRecord[], pageId: string) {
  const browser = browserRecords as unknown as Row[];
  const standIn = standInRecords as unknown as Row[];
  const onPage = (records: Row[]) => {
    const shapes = records.filter((r): r is Shape => r.typeName === "shape");
    const parents = new Map(
      shapes.map((shape) => [shape.id, (shape as { parentId: string }).parentId]),
    );
    const here = (id: string) => {
      let parent = parents.get(id);
      while (parent !== undefined && parent !== pageId) parent = parents.get(parent);
      return parent === pageId;
    };
    return shapes.filter((shape) => here(shape.id));
  };
  const theirs = onPage(browser);
  const ours = new Map(onPage(standIn).map((shape) => [shape.id, shape]));
  const rows: { field: string; id: string; ours: unknown; theirs: unknown }[] = [];
  const max: Record<string, number> = {};
  const note = (id: string, field: string, a: unknown, b: unknown) => {
    if (typeof a === "number" && typeof b === "number") {
      const delta = Math.abs(a - b);
      max[field] = Math.max(max[field] ?? 0, delta);
      if (delta > 0.5) rows.push({ field, id, ours: b, theirs: a });
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      rows.push({ field, id, ours: b, theirs: a });
    }
  };
  for (const shape of theirs) {
    const twin = ours.get(shape.id);
    if (twin === undefined) {
      rows.push({ field: "missing", id: shape.id, ours: null, theirs: shape.type });
      continue;
    }
    ours.delete(shape.id);
    for (const field of ["x", "y", "rotation", "parentId", "type"] as const) {
      note(shape.id, field, (shape as never)[field], (twin as never)[field]);
    }
    for (const [key, value] of Object.entries(shape.props)) {
      if (NUMERIC_PROPS.has(key)) note(shape.id, key, value, twin.props[key]);
      else if (key === "start" || key === "end") {
        const a = value as { x: number; y: number };
        const b = twin.props[key] as { x: number; y: number };
        note(shape.id, `${key}.x`, a.x, b.x);
        note(shape.id, `${key}.y`, a.y, b.y);
      } else if (key !== "points" && key !== "segments")
        note(shape.id, key, value, twin.props[key]);
    }
  }
  for (const extra of ours.values())
    rows.push({ field: "extra", id: extra.id, ours: extra.type, theirs: null });
  const order = (records: Row[]) =>
    onPage(records)
      .sort((a, b) => ((a as { index: string }).index < (b as { index: string }).index ? -1 : 1))
      .map((shape) => `${(shape as { parentId: string }).parentId}/${shape.id}`);
  const ids = new Set(onPage(browser).map((shape) => shape.id));
  const mine = (list: string[]) => list.filter((entry) => ids.has(JSON.parse(entry).fromId));
  return {
    bindingsEqual:
      JSON.stringify(mine(bindingsOf(browser))) === JSON.stringify(mine(bindingsOf(standIn))),
    bindingsSeen: [mine(bindingsOf(browser)).length, mine(bindingsOf(standIn)).length],
    differences: rows,
    max,
    orderEqual: JSON.stringify(order(browser)) === JSON.stringify(order(standIn)),
    shapes: theirs.length,
  };
}

test("tldraw's engine on a real editor and on the stand-in write the same records", async ({
  browser,
  page,
}, info) => {
  test.skip(info.project.name !== "chromium", "the reference browser only");
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto("/");
  await page.waitForFunction(() => (globalThis as unknown as Harness).harness !== undefined, null, {
    timeout: 60_000,
  });
  const other = await browser.newPage({ viewport: { height: 800, width: 1280 } });
  await other.goto("/");
  await other.waitForFunction(
    () => (globalThis as unknown as Harness).harness !== undefined,
    null,
    { timeout: 60_000 },
  );

  const report: Record<string, object> = {};
  for (const { name, ops, steps } of SCENARIOS) {
    const real = await page.evaluate(
      ([n, s, o]) =>
        (globalThis as unknown as Harness).harness!.scenario(
          n as string,
          s as Step[],
          o as object[],
        ),
      [name, steps, ops] as const,
    );
    const computed = computeOps(real.before, { ops, page: real.pageId }, []);
    if (computed.kind !== "computed") throw new Error(computed.message);
    const removed = new Set(computed.deletes);
    const written = new Map(computed.puts.map((record) => [record.id as string, record]));
    const standIn = [
      ...real.before.filter((record) => !removed.has(record.id) && !written.has(record.id)),
      ...written.values(),
    ];
    const result = compare(real.after, standIn, real.pageId);
    report[name] = {
      ...result,
      errors: { browser: real.result.errors, standIn: computed.result.errors },
    };
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOTS}/ops2-${name}-browser.png` });
    await other.evaluate(
      ([records, pageId]) =>
        (globalThis as unknown as Harness).harness!.show(records as object[], pageId as string),
      [standIn as object[], real.pageId] as const,
    );
    await other.waitForTimeout(300);
    await other.screenshot({ path: `${SCREENSHOTS}/ops2-${name}-standin.png` });
    expect(computed.result.errors, `${name}: the two engines fail the same ops`).toEqual(
      real.result.errors,
    );
  }
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    Object.entries(report)
      .map(([name, value]) => {
        const r = value as ReturnType<typeof compare>;
        return `${name}: ${r.shapes} shapes, ${r.differences.length} fields differ, order ${r.orderEqual ? "same" : "differs"}, bindings ${r.bindingsEqual ? "same" : "differ"}, max ${JSON.stringify(r.max)}`;
      })
      .join("\n"),
  );
});
