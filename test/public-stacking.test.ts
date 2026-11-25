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
import { expect, it } from "vitest";

import { stampPublicShape } from "../src/public-board-expiry";
import { PUBLIC_SIGNATURE_GROUP } from "../src/public-signature";
import { Browser, standaloneEnv } from "./standalone-support";

it.each([
  { name: "upper stroke stored first", upperFirst: true, nested: false, sharedIndex: false },
  {
    name: "lower stroke stored first in a nested group",
    upperFirst: false,
    nested: true,
    sharedIndex: false,
  },
  { name: "equal sibling indices", upperFirst: true, nested: false, sharedIndex: true },
])(
  "preserves paint order when a group expires with $name",
  async ({ upperFirst, nested, sharedIndex }) => {
    const response = await new Browser().post("/api/public-board/bootstrap");
    expect(response.status).toBe(200);
    const { board } = await response.json<{ board: string }>();
    const namespace = standaloneEnv.BoardRoom;
    const room = namespace.get(namespace.idFromName(board));
    const suffix = nested ? "nested" : sharedIndex ? "shared" : "flat";
    const groupId = createShapeId(`aging-group-${suffix}`);
    const nestedGroupId = createShapeId("aging-inner-group");
    const lower = createShapeId(`lower-stroke-${suffix}`);
    const upper = createShapeId(`upper-stroke-${suffix}`);
    const overlay = createShapeId(`overlay-stroke-${suffix}`);
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
        const groupIndex = sharedIndex ? group.index : getIndexAbove(group.index);
        const old = stampPublicShape(
          { ...group, id: groupId, index: groupIndex, x: 0, y: 0 },
          now - 49 * 60 * 60 * 1000,
        );
        store.set(old.id, old);
        const above = getIndexAbove(stroke.index);
        if (nested) {
          store.set(nestedGroupId, { ...old, id: nestedGroupId, parentId: groupId, index: above });
        }
        const lowerStroke = [lower, groupId, stroke.index, "red"] as const;
        const upperStroke = [upper, nested ? nestedGroupId : groupId, above, "blue"] as const;
        for (const [id, parentId, index, color] of [
          ...(upperFirst ? [upperStroke, lowerStroke] : [lowerStroke, upperStroke]),
          [overlay, group.parentId, sharedIndex ? groupIndex : getIndexAbove(groupIndex), "green"],
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

    const before = await paintOrder();
    expect(before).toEqual([lower, upper, overlay]);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await paintOrder()).toEqual(before);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await paintOrder()).toEqual(before);
  },
);
