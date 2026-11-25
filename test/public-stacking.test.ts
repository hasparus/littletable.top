import { DurableObjectSqliteSyncWrapper, SQLiteSyncStorage } from "@tldraw/sync-core";
import {
  createShapeId,
  PageRecordType,
  isShape,
  type TLRecord,
  type TLShape,
} from "@tldraw/tlschema";
import { getIndexAbove, sortByIndex } from "@tldraw/utils";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

import { stampPublicShape } from "../src/public-board-expiry";
import { PUBLIC_SIGNATURE_GROUP } from "../src/public-signature";
import { Browser, standaloneEnv } from "./standalone-support";

let before: string[];
let after: string[];

beforeAll(async () => {
  const response = await new Browser().post("/api/public-board/bootstrap");
  expect(response.status).toBe(200);
  const { board } = await response.json<{ board: string }>();
  const namespace = standaloneEnv.BoardRoom;
  const room = namespace.get(namespace.idFromName(board));
  const groupId = createShapeId("aging-group");
  const lower = createShapeId("lower-stroke");
  const upper = createShapeId("upper-stroke");
  const overlay = createShapeId("overlay-stroke");
  const drawing = (state: DurableObjectState) =>
    new SQLiteSyncStorage<TLRecord>({
      sql: new DurableObjectSqliteSyncWrapper(state.storage, { tablePrefix: "tldraw_" }),
    });

  await runInDurableObject(room, (_instance, state) => {
    drawing(state).transaction((store) => {
      const group = store.get(PUBLIC_SIGNATURE_GROUP);
      if (!group || !isShape(group) || group.type !== "group")
        throw new Error("missing group fixture");
      const stroke = [...store.values()]
        .filter(isShape)
        .find((s) => s.parentId === group.id && s.type === "draw");
      if (!stroke || stroke.type !== "draw") throw new Error("missing stroke fixture");
      const now = Date.now();
      const old = stampPublicShape(
        { ...group, id: groupId, index: getIndexAbove(group.index), x: 0, y: 0 },
        now - 49 * 60 * 60 * 1000,
      );
      store.set(old.id, old);
      // Insert the upper stroke first. Paint order is determined by index, independently of insertion.
      const above = getIndexAbove(stroke.index);
      for (const [id, parentId, index, color] of [
        [upper, groupId, above, "blue"],
        [lower, groupId, stroke.index, "red"],
        [overlay, group.parentId, getIndexAbove(old.index), "green"],
      ] as const)
        store.set(
          id,
          stampPublicShape(
            { ...stroke, id, parentId, index, props: { ...stroke.props, color } },
            now,
          ),
        );
    });
  });

  async function paintOrder() {
    return runInDurableObject(
      room,
      (_instance, state) =>
        drawing(state).transaction((store) => {
          const shapes = [...store.values()].filter(isShape);
          function leaves(parent: TLShape["parentId"]): string[] {
            return shapes
              .filter((s) => s.parentId === parent)
              .sort(sortByIndex)
              .flatMap((s) => (s.type === "group" ? leaves(s.id) : [s.id]));
          }
          return leaves(PageRecordType.createId("page")).filter((id) =>
            [lower, upper, overlay].some((stroke) => stroke === id),
          );
        }).result,
    );
  }

  before = await paintOrder();
  expect(before).toEqual([lower, upper, overlay]);
  expect(await runDurableObjectAlarm(room)).toBe(true);
  after = await paintOrder();
  expect(after.toSorted()).toEqual(before.toSorted());
});

// Remove .fails when the expiry sweep preserves the visible stacking order.
it.fails("preserves paint order when an overlapping group expires", () => {
  expect(after).toEqual(before);
});
