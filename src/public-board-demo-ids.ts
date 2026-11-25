import { AssetRecordType, createShapeId, type TLRecord } from "@tldraw/tlschema";

// Standalone account board IDs are alphanumeric and cannot collide with this room.
export const PUBLIC_BOARD = "public-lobby";

export const PUBLIC_DEMO_ASSET = AssetRecordType.createId("north-gate-demo");
export const PUBLIC_DEMO_SHAPE = createShapeId("north-gate-demo");

export function isPublicDemo(id: TLRecord["id"]): boolean {
  return id === PUBLIC_DEMO_ASSET || id === PUBLIC_DEMO_SHAPE;
}
