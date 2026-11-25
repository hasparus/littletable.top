import type { TLSyncStorageTransaction } from "@tldraw/sync-core";
import type { TLAssetId, TLRecord } from "@tldraw/tlschema";
import type { IndexKey } from "@tldraw/utils";

import { isBinding, isShape } from "@tldraw/tlschema";
import { getIndicesBetween, sortByIndex } from "@tldraw/utils";

import type { ArrowTerminal } from "./public-arrow-endpoints";

import { savedArrowEndpoint } from "./public-arrow-endpoints";
import { isPublicSignature } from "./public-signature";

type Drawing = Extract<TLRecord, { typeName: "shape" }>;
type DrawingId = Drawing["id"];

export const PUBLIC_SWEEP_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 4 * PUBLIC_SWEEP_MS;
const CREATED_AT = "littleTablePublicCreatedAt";

function creationTime(drawing: Drawing): number | null {
  const timestamp = drawing.meta[CREATED_AT];
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

export function stampPublicShape(drawing: Drawing, now: number): Drawing {
  return { ...drawing, meta: { ...drawing.meta, [CREATED_AT]: now } };
}

export function preservesPublicShapeAge(before: Drawing, after: Drawing): boolean {
  return before.meta[CREATED_AT] === after.meta[CREATED_AT];
}

function indicesAfterExpiry(
  drawings: Iterable<Drawing>,
  expired: ReadonlySet<Drawing["parentId"]>,
) {
  const indices = new Map<DrawingId, IndexKey>();
  if (expired.size === 0) return indices;

  const children = new Map<Drawing["parentId"], Drawing[]>();
  for (const drawing of drawings) {
    const siblings = children.get(drawing.parentId) ?? [];
    siblings.push(drawing);
    children.set(drawing.parentId, siblings);
  }
  for (const [parentId, siblings] of children) {
    if (expired.has(parentId) || !siblings.some((drawing) => expired.has(drawing.id))) continue;

    const ordered: Drawing[] = [];
    const pending = siblings.sort(sortByIndex).toReversed();
    while (pending.length > 0) {
      const drawing = pending.pop()!;
      if (expired.has(drawing.id)) {
        const nested = children.get(drawing.id)?.sort(sortByIndex);
        if (nested) for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i]!);
      } else {
        ordered.push(drawing);
      }
    }

    for (let start = 0; start < ordered.length; ) {
      if (ordered[start]!.parentId === parentId) {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < ordered.length && ordered[end]!.parentId !== parentId) end++;
      const below = ordered[start - 1]?.index;
      const above = ordered[end]?.index;
      const reindexSiblings = below !== undefined && below === above;
      if (reindexSiblings) {
        start = 0;
        end = ordered.length;
      }
      const keys = getIndicesBetween(
        reindexSiblings ? null : below,
        reindexSiblings ? null : above,
        end - start,
      );
      for (const [offset, index] of keys.entries()) indices.set(ordered[start + offset]!.id, index);
      start = end;
    }
  }
  return indices;
}

export function expirePublicShapes(store: TLSyncStorageTransaction<TLRecord>, now: number) {
  const records = [...store.values()];
  const drawings = new Map<string, Drawing>(
    records.filter(isShape).map((drawing) => [drawing.id, drawing]),
  );
  const expired = new Set<Drawing["parentId"]>();

  for (const drawing of drawings.values()) {
    const { id } = drawing;
    const created = creationTime(drawing);
    if (!isPublicSignature(id) && created !== null && now - created >= 2 * DAY_MS) {
      expired.add(id);
    }
  }
  const indices = indicesAfterExpiry(drawings.values(), expired);

  const detached = new Map<DrawingId, ArrowTerminal[]>();
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

  for (const drawing of drawings.values()) {
    const { id } = drawing;
    const index = indices.get(id) ?? drawing.index;
    let next = index === drawing.index ? drawing : { ...drawing, index };
    if (isPublicSignature(id)) {
      if (next !== drawing) store.set(id, next);
      continue;
    }
    if (expired.has(id)) {
      store.delete(id);
      continue;
    }
    const created = creationTime(drawing);
    if (created === null) next = stampPublicShape(next, now);
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

    // WARNING: Reparenting without composing the removed transforms would move surviving drawings.
    const visited = new Set<DrawingId>();
    let parent = drawings.get(next.parentId);
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
      parent = drawings.get(next.parentId);
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
