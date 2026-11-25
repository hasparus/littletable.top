// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- tldraw’s canonical ID factory.
import { AssetRecordType, createShapeId, type TLRecord } from "@tldraw/tlschema";

/** Account board IDs are alphanumeric, so they cannot collide with this room name. */
export const PUBLIC_BOARD = "public-lobby";

export const PUBLIC_HANDOUT_ASSET = AssetRecordType.createId("north-gate-demo");
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Reuse tldraw’s canonical ID factory.
export const PUBLIC_HANDOUT = createShapeId("north-gate-demo");

export function isPublicDemo(id: TLRecord["id"]) {
  return id === PUBLIC_HANDOUT_ASSET || id === PUBLIC_HANDOUT;
}
