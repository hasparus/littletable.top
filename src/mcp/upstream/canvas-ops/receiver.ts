// Adapted from tldraw: apps/dotcom/client/src/tla/utils/canvas-ops/receiver.ts
// at commit ebe1433. Copyright (c) tldraw Inc. Used with permission; what was
// changed is listed in docs/upstream-provenance.md.

import type { Editor } from "../../editor/tldraw";

import { applyOps } from "./ops";
import { AttributionSchema, OpsBatchSchema, type ApplyOpsResult } from "./schema";

/**
 * Applies canvas ops from an untrusted sender to `editor`. Input is validated before anything touches
 * the store: a batch that fails validation throws a ZodError without applying any op.
 */
export function createCanvasOpsReceiver(editor: Editor) {
  return {
    applyBatch(batch: unknown, attribution?: unknown): ApplyOpsResult {
      const { ops } = OpsBatchSchema.parse(batch);
      return applyOps(editor, ops, AttributionSchema.parse(attribution ?? {}));
    },
  };
}
