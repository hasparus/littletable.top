import type { TLRecord } from "@tldraw/tlschema";

import { describe, expect, it } from "vitest";

import { clustersOf } from "../../src/ops/clusters";
import { Doc } from "../../src/ops/doc";
import { runBatch } from "../../src/ops/engine";

// Clusters come from records alone: no editor, no browser.

const PAGE: TLRecord[] = [
  { id: "page:page", index: "a1", meta: {}, name: "Page 1", typeName: "page" } as TLRecord,
];

function pageWith(ops: object[]): Doc {
  const outcome = runBatch(PAGE, { batchId: "b", now: 0, ops, run: { created: [] } });
  if (outcome.kind !== "applied" || outcome.result.errors.length > 0) {
    throw new Error(JSON.stringify(outcome));
  }
  return new Doc([...PAGE, ...outcome.puts]);
}

describe("page clusters", () => {
  it("gathers neighbours, keeps distant groups apart, and lets an arrow join what it binds", () => {
    const doc = pageWith([
      { at: { x: 0, y: 0 }, id: "inn", op: "add", text: "Inn of the goblin" },
      { id: "stable", op: "add", relation: "right_of", target: "inn", text: "Stable goblin" },
      { at: { x: 3_000, y: 0 }, id: "tower", op: "add", text: "Wizard tower" },
      { at: { x: 3_000, y: 3_000 }, id: "crypt", op: "add", text: "Crypt" },
      { at: { x: 6_000, y: 6_000 }, id: "portal", op: "add", text: "Portal" },
      { from: "crypt", id: "leads", op: "connect", to: "portal" },
    ]);
    const clusters = clustersOf(doc, "page:page" as never);
    expect(clusters.map((cluster) => [...cluster.shapeIds].sort())).toEqual([
      ["crypt", "leads", "portal"],
      ["inn", "stable"],
      ["tower"],
    ]);
    expect(clusters[1]!.keywords[0]).toBe("goblin");
    expect(clusters[2]).toMatchObject({ label: "tower wizard", numberOfShapes: 1 });
    expect(clustersOf(doc, "page:page" as never).map((c) => c.id)).toEqual(
      clusters.map((c) => c.id),
    );
  });
});
