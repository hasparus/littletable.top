import type { TLPage } from "@tldraw/tlschema";

import type { BoardGrant, DocumentScope, RoomDocumentCalls } from "../room-document";

import { Doc } from "../ops/doc";
import { runBatch } from "../ops/engine";
import { type ApplyOpsResult } from "../ops/schema";

// The MCP Worker's side of a board: it reads a snapshot from the room,
// computes here (the engine, the measurer and the fonts never load in the
// board's Worker), and commits the diff. The room refuses a diff whose
// footing moved while it was being computed; then it is computed again from
// a fresh snapshot, a bounded number of times.

export const MAX_ATTEMPTS = 3;

export type ApplyOpsRequest = { ops: unknown; page?: number | string | null; runId?: string };

export type ApplyOpsResponse =
  | "read-only"
  | "revoked"
  | { attempts: number; kind: "applied"; result: ApplyOpsResult }
  | { kind: "busy" | "invalid" | "no-page"; message: string };

const pageScope = (page: ApplyOpsRequest["page"]): DocumentScope =>
  typeof page === "string"
    ? { page: page.startsWith("page:") ? page : `page:${page}` }
    : "document";

export async function applyOps(
  room: RoomDocumentCalls,
  grant: BoardGrant,
  request: ApplyOpsRequest,
): Promise<ApplyOpsResponse> {
  if (grant.access !== "write") return "read-only";
  const batchId = crypto.randomUUID();
  let scope = pageScope(request.page);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const snapshot = await room.readDocument(grant, { runId: request.runId, scope });
    if (snapshot === "revoked") return snapshot;
    const outcome = runBatch(snapshot.records, {
      batchId,
      now: Date.now(),
      ops: request.ops,
      page: request.page,
      run: { created: snapshot.created },
      runId: request.runId,
    });
    if (outcome.kind !== "applied") return outcome;
    const done = { attempts: attempt, kind: "applied", result: outcome.result } as const;
    if (outcome.puts.length === 0 && outcome.deletes.length === 0) return done;
    const committed = await room.commitDocument(grant, {
      absent: outcome.absent,
      puts: outcome.puts,
      removes: outcome.deletes,
      run:
        request.runId === undefined ? undefined : { created: outcome.created, id: request.runId },
      since: snapshot.clock,
      unchanged: outcome.unchanged,
    });
    if (committed === "revoked" || committed === "read-only") return committed;
    if (committed.kind === "committed") return done;
    if (committed.kind === "invalid") {
      return {
        kind: "invalid",
        message: `The board refused a record this batch wrote (${committed.message}); nothing was applied.`,
      };
    }
    // NOTE: an id taken on another page is invisible in one page's records.
    scope = "document";
  }
  return {
    kind: "busy",
    message: `People kept changing the shapes this batch touches (${MAX_ATTEMPTS} attempts); nothing was applied. Send it again, or in smaller batches.`,
  };
}

export type PageInfo = { hasContent: boolean; id: string; index: number; name: string };

export async function pages(
  room: RoomDocumentCalls,
  grant: BoardGrant,
): Promise<"revoked" | PageInfo[]> {
  const snapshot = await room.readDocument(grant, { scope: "document" });
  if (snapshot === "revoked") return snapshot;
  const doc = new Doc(snapshot.records);
  return doc.pages().map((page: TLPage, index) => ({
    hasContent: doc.children(page.id).length > 0,
    id: page.id,
    index,
    name: page.name,
  }));
}
