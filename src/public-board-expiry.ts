import type { TLSyncStorageTransaction } from "@tldraw/sync-core";
import type { TLAssetId, TLRecord, TLShape, TLShapeId } from "@tldraw/tlschema";
import type { IndexKey } from "@tldraw/utils";

import { isBinding, isShape } from "@tldraw/tlschema";
import { getIndexAbove } from "@tldraw/utils";

import type { ArrowTerminal } from "./public-arrow-endpoints";

import { savedArrowEndpoint } from "./public-arrow-endpoints";
import { PUBLIC_HANDOUT } from "./public-board-demo-ids";

export const PUBLIC_SWEEP_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 4 * PUBLIC_SWEEP_MS;
const CREATED_AT = "littleTablePublicCreatedAt";

function creationTime(shape: TLShape): number | null {
  const timestamp = shape.meta[CREATED_AT];
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

export function stampPublicShape(shape: TLShape, now: number): TLShape {
  return { ...shape, meta: { ...shape.meta, [CREATED_AT]: now } };
}

export function preservesPublicShapeAge(before: TLShape, after: TLShape): boolean {
  return before.meta[CREATED_AT] === after.meta[CREATED_AT];
}

export function expirePublicShapes(store: TLSyncStorageTransaction<TLRecord>, now: number): void {
  const records = [...store.values()];
  const shapes = new Map<string, TLShape>(
    records.filter(isShape).map((shape) => [shape.id, shape]),
  );
  const expired = new Set<TLShapeId>();
  const lastIndex = new Map<TLShape["parentId"], IndexKey>();

  for (const drawing of shapes.values()) {
    const created = creationTime(drawing);
    if (drawing.id !== PUBLIC_HANDOUT && created !== null && now - created >= 2 * DAY_MS)
      expired.add(drawing.id);
    const last = lastIndex.get(drawing.parentId);
    if (last === undefined || last < drawing.index) lastIndex.set(drawing.parentId, drawing.index);
  }

  const detached = new Map<TLShapeId, ArrowTerminal[]>();
  for (const record of records) {
    if (!isBinding(record)) continue;
    if (expired.has(record.fromId) || expired.has(record.toId)) {
      store.delete(record.id);
      if (record.type === "arrow" && !expired.has(record.fromId)) {
        const terminals = detached.get(record.fromId) ?? [];
        terminals.push(record.props.terminal);
        detached.set(record.fromId, terminals);
      }
    }
  }

  for (const drawing of shapes.values()) {
    if (drawing.id === PUBLIC_HANDOUT) continue;
    if (expired.has(drawing.id)) {
      store.delete(drawing.id);
      continue;
    }
    const created = creationTime(drawing);
    let next = created === null ? stampPublicShape(drawing, now) : drawing;
    if (created !== null && now - created >= DAY_MS && next.opacity > 0.5) {
      next = { ...next, opacity: 0.5 };
    }

    if (next.type === "arrow") {
      for (const terminal of detached.get(next.id) ?? []) {
        const endpoint = savedArrowEndpoint(next.meta, terminal);
        if (endpoint !== undefined)
          next = { ...next, props: { ...next.props, [terminal]: endpoint } };
      }
    }

    // WARNING: Reparenting without composing the removed transforms would move surviving shapes.
    const visited = new Set<TLShapeId>();
    let parent = shapes.get(next.parentId);
    while (parent !== undefined && expired.has(parent.id) && !visited.has(parent.id)) {
      visited.add(parent.id);
      const sin = Math.sin(parent.rotation);
      const cos = Math.cos(parent.rotation);
      next = {
        ...next,
        parentId: parent.parentId,
        rotation: parent.rotation + next.rotation,
        x: parent.x + cos * next.x - sin * next.y,
        y: parent.y + sin * next.x + cos * next.y,
      };
      parent = shapes.get(next.parentId);
    }
    if (next.parentId !== drawing.parentId) {
      const index = getIndexAbove(lastIndex.get(next.parentId));
      lastIndex.set(next.parentId, index);
      next = { ...next, index };
    }
    if (next !== drawing) store.set(next.id, next);
  }
}

export function publicFileReferences(records: Iterable<TLRecord>, board: string) {
  const assetIds = new Set<string>();
  const assetsByHash = new Map<string, TLAssetId[]>();
  const live = new Set<string>();
  const prefix = `/rooms/${board}/files/`;
  for (const record of records) {
    if (isShape(record) && "assetId" in record.props && typeof record.props.assetId === "string") {
      assetIds.add(record.props.assetId);
    }
    if (
      record.typeName !== "asset" ||
      !("src" in record.props) ||
      typeof record.props.src !== "string"
    )
      continue;
    if (!record.props.src.startsWith(prefix)) continue;
    const hash = record.props.src.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/u.test(hash)) continue;
    const ids = assetsByHash.get(hash) ?? [];
    ids.push(record.id);
    assetsByHash.set(hash, ids);
  }
  for (const [hash, ids] of assetsByHash) {
    if (ids.some((id) => assetIds.has(id))) live.add(hash);
  }
  return { assetsByHash, live };
}
