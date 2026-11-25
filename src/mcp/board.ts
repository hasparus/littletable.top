import type { TLPage, TLPageId, TLRecord, TLShapeId } from "@tldraw/tlschema";

import { z } from "zod";

import type { BoardGrant, DocumentScope, RoomDocumentCalls } from "../room-contract";

import { Doc } from "../ops/doc";
import { InvalidRecord } from "../ops/records";
import { StandInEditor } from "./editor/editor";
import { primeRunMemory } from "./upstream/canvas-ops/actions";
import { applyOps as runOps } from "./upstream/canvas-ops/ops";
import { type ApplyOpsResult, OpsBatchSchema } from "./upstream/canvas-ops/schema";

// The MCP Worker's side of a board: it reads a snapshot from the room, runs
// tldraw's canvas-ops engine here on a stand-in editor over that snapshot
// (the engine, the measurer and the fonts never load in the board's
// Worker), and commits the diff. The room refuses a diff whose footing
// moved while it was being computed; then it is computed again from a
// fresh snapshot, a bounded number of times.

export const MAX_ATTEMPTS = 3;

export type ApplyOpsRequest = { ops: unknown; page?: number | string | null; runId?: string };

export type BoardOpsResult = ApplyOpsResult & { pageId: string; pageName: string };

export type ApplyOpsResponse =
  | "read-only"
  | "revoked"
  | { attempts: number; kind: "applied"; result: BoardOpsResult }
  | { kind: "busy" | "invalid" | "no-page"; message: string };

const pageScope = (page: ApplyOpsRequest["page"]): DocumentScope =>
  typeof page === "string"
    ? { page: page.startsWith("page:") ? page : `page:${page}` }
    : "document";

export function pageOf(doc: Doc, page: ApplyOpsRequest["page"]): TLPage | string {
  const pages = doc.pages();
  if (pages.length === 0) return "This board has no pages.";
  if (page === undefined || page === null) return pages[0]!;
  if (typeof page === "number") {
    return (
      pages[page] ??
      `There is no page ${page}; this board has ${pages.length} (0 to ${pages.length - 1}).`
    );
  }
  const id = page.startsWith("page:") ? page : `page:${page}`;
  return pages.find((candidate) => candidate.id === id) ?? `There is no page with the id ${page}.`;
}

type Computed =
  | {
      absent: string[];
      created: string[];
      deletes: string[];
      kind: "computed";
      puts: TLRecord[];
      result: BoardOpsResult;
      unchanged: string[];
    }
  | { kind: "invalid" | "no-page"; message: string };

/** One batch on a snapshot: tldraw's engine over the stand-in editor. Nothing is written. */
export function computeOps(
  records: Iterable<TLRecord>,
  request: ApplyOpsRequest,
  created: string[],
): Computed {
  const parsed = OpsBatchSchema.safeParse({ ops: request.ops });
  if (!parsed.success) {
    return {
      kind: "invalid",
      message:
        `The batch is invalid and nothing was applied.\n${z.prettifyError(parsed.error)}`.slice(
          0,
          1500,
        ),
    };
  }
  const doc = new Doc(records);
  const page = pageOf(doc, request.page);
  if (typeof page === "string") return { kind: "no-page", message: page };
  const editor = new StandInEditor(doc, page.id as TLPageId);
  const memory =
    request.runId === undefined
      ? null
      : primeRunMemory(editor, request.runId, created as TLShapeId[]);
  let result: ApplyOpsResult;
  try {
    result = runOps(editor, parsed.data.ops, { runId: request.runId });
  } catch (error) {
    if (!(error instanceof InvalidRecord)) throw error;
    return {
      kind: "invalid",
      message: `The batch wrote a record tldraw refuses: ${error.message}`,
    };
  }
  doc.depend(page.id);
  const { deletes, puts } = doc.changes();
  return {
    ...doc.preconditions(),
    created: memory === null ? [] : memory.created.slice(created.length),
    deletes,
    kind: "computed",
    puts,
    result: { ...result, pageId: page.id, pageName: page.name },
  };
}

export async function applyOps(
  room: RoomDocumentCalls,
  grant: BoardGrant,
  request: ApplyOpsRequest,
): Promise<ApplyOpsResponse> {
  if (grant.access !== "write") return "read-only";
  let scope = pageScope(request.page);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const snapshot = await room.readDocument(grant, { runId: request.runId, scope });
    if (snapshot === "revoked") return snapshot;
    const outcome = computeOps(snapshot.records, request, snapshot.created);
    if (outcome.kind !== "computed") return outcome;
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
