import type { TLSyncStorage } from "@tldraw/sync-core";
import type { TLPage, TLRecord } from "@tldraw/tlschema";

import { Doc } from "./doc";
import { type BatchInput, runBatch } from "./engine";
import { type ApplyOpsResult } from "./schema";

// The board's side of apply_ops, inside its Durable Object: read the
// document, run the engine, write what it changed in one storage
// transaction (which the sync room sends to every connected browser), and
// remember what each run made so a later call's {created} refs reach it.
// Nobody needs to have the board open.

const RUN_DAYS = 7;

export type ApplyOpsRequest = Pick<BatchInput, "ops" | "page" | "runId">;

export type ApplyOpsResponse =
  | { kind: "applied"; result: ApplyOpsResult }
  | { kind: "invalid" | "no-page"; message: string };

export class BoardOps {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: () => TLSyncStorage<TLRecord>,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_runs (run_id TEXT NOT NULL, seq INTEGER NOT NULL, shape TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (run_id, seq))",
    );
  }

  private records(): TLRecord[] {
    return this.storage().transaction((txn) => [...txn.values()]).result;
  }

  private createdIn(runId: string | undefined): string[] {
    if (runId === undefined) return [];
    return this.sql
      .exec("SELECT shape FROM mcp_runs WHERE run_id = ? ORDER BY seq", runId)
      .toArray()
      .map((row) => row.shape as string);
  }

  private remember(runId: string, created: string[], now: number) {
    const [row] = this.sql
      .exec("SELECT COALESCE(MAX(seq), -1) AS last FROM mcp_runs WHERE run_id = ?", runId)
      .toArray();
    let seq = (row!.last as number) + 1;
    for (const shape of created) {
      this.sql.exec(
        "INSERT INTO mcp_runs (run_id, seq, shape, at) VALUES (?, ?, ?, ?)",
        runId,
        seq++,
        shape,
        now,
      );
    }
    this.sql.exec("DELETE FROM mcp_runs WHERE at < ?", now - RUN_DAYS * 86_400_000);
  }

  apply(request: ApplyOpsRequest, now = Date.now()): ApplyOpsResponse {
    const batchId = crypto.randomUUID();
    const outcome = runBatch(this.records(), {
      batchId,
      now,
      ops: request.ops,
      page: request.page,
      run: { created: this.createdIn(request.runId) },
      runId: request.runId,
    });
    if (outcome.kind !== "applied") return outcome;
    if (outcome.puts.length > 0 || outcome.deletes.length > 0) {
      // NOTE: one transaction is one change for the room: every connected
      // browser gets the whole batch in one patch, never half of it.
      this.storage().transaction((txn) => {
        for (const record of outcome.puts) txn.set(record.id, record);
        for (const id of outcome.deletes) txn.delete(id);
      });
    }
    if (request.runId !== undefined && outcome.created.length > 0) {
      this.remember(request.runId, outcome.created, now);
    }
    return { kind: "applied", result: outcome.result };
  }

  pages(): { hasContent: boolean; id: string; index: number; name: string }[] {
    const doc = new Doc(this.records());
    return doc.pages().map((page: TLPage, index) => ({
      hasContent: doc.children(page.id).length > 0,
      id: page.id,
      index,
      name: page.name,
    }));
  }
}
