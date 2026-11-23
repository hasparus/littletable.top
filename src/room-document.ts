import type { TLSyncStorage } from "@tldraw/sync-core";

import { createTLSchema, type TLRecord } from "@tldraw/tlschema";

// The board's document as another Worker may use it: read a consistent
// snapshot with the document clock, and later commit a diff computed from
// it, which the room accepts only if nothing that diff relied on has
// changed since. The room knows nothing about why the diff exists (ops,
// measuring and MCP live in the other Worker); it keeps the document whole
// and remembers, per run, which shapes that run made.

// What an assistant may do on this board, as its verified token says. The
// room refuses a grant older than its grant version (the host revoked it).
export type BoardGrant = {
  access: "read" | "write";
  board: string;
  /** The board's grant version when the host signed this; a lower one is revoked. */
  grant: number;
  /** The board's title, as the host knows it. */
  title: string | null;
};

export type DocumentScope = { page: string } | "document";

export type DocumentSnapshot = {
  clock: number;
  /** Shapes made earlier by the run asked about, oldest first. */
  created: string[];
  records: TLRecord[];
};

export type DocumentDiff = {
  /** Ids the diff creates: none may exist yet. */
  absent: string[];
  puts: TLRecord[];
  removes: string[];
  /** What the run made in this diff, to remember for later calls. */
  run?: { created: string[]; id: string };
  /** The clock of the snapshot the diff was computed from. */
  since: number;
  /** Records the diff read and relied on, or overwrites: all as they were at `since`. */
  unchanged: string[];
};

export type CommitOutcome =
  | { clock: number; kind: "committed" }
  // Someone changed these since the snapshot (or, for "stale", the room no
  // longer knows what changed): read again and recompute.
  | { kind: "conflict"; records: string[]; why: "changed" | "exists" | "referenced" | "stale" }
  | { kind: "invalid"; message: string };

const RUN_DAYS = 7;
const schema = createTLSchema();

const referencesOf = (record: TLRecord): string[] => {
  if (record.typeName === "shape") return [record.parentId];
  if (record.typeName === "binding") return [record.fromId, record.toId];
  return [];
};

// The room's calls as a Worker bound to its class makes them.
// NOTE: written out because the stub's inferred types recurse through every
// tldraw record type until TypeScript gives up.
export type RoomDocumentCalls = {
  commitDocument(
    grant: BoardGrant,
    diff: DocumentDiff,
  ): Promise<CommitOutcome | "read-only" | "revoked">;
  readDocument(
    grant: BoardGrant,
    request: { runId?: string; scope: DocumentScope },
  ): Promise<DocumentSnapshot | "revoked">;
  revokeMcpGrants(board: string, version: number): Promise<void>;
};

export class RoomDocument {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: () => TLSyncStorage<TLRecord>,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_runs (run_id TEXT NOT NULL, seq INTEGER NOT NULL, shape TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (run_id, seq))",
    );
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

  read(scope: DocumentScope, runId?: string): DocumentSnapshot {
    const { clock, records } = this.storage().transaction((txn) => ({
      clock: txn.getClock(),
      records: [...txn.values()],
    })).result;
    return {
      clock,
      created: this.createdIn(runId),
      records: scope === "document" ? records : onPage(records, scope.page),
    };
  }

  commit(diff: DocumentDiff, now = Date.now()): CommitOutcome {
    for (const record of diff.puts) {
      const type = (schema.types as Record<string, { validate: (r: unknown) => unknown }>)[
        record.typeName
      ];
      try {
        if (type === undefined) throw new Error(`no record type ${record.typeName}`);
        type.validate(record);
      } catch (error) {
        return { kind: "invalid", message: `${record.id}: ${(error as Error).message}` };
      }
    }
    // NOTE: one synchronous transaction: the checks and the writes see the
    // same document, and the room sends the writes to browsers as one patch.
    const outcome = this.storage().transaction((txn): CommitOutcome => {
      // NOTE: sync-core stamps each record with the clock of its last
      // change and keeps tombstones, so this is a per-record check: undefined
      // means nothing changed; wipeAll, that the history no longer reaches
      // back to the snapshot.
      const changes = txn.getChangesSince(diff.since);
      if (changes?.wipeAll === true) return { kind: "conflict", records: [], why: "stale" };
      const touched = new Set(
        changes === undefined ? [] : [...Object.keys(changes.diff.puts), ...changes.diff.deletes],
      );
      const changed = diff.unchanged.filter((id) => touched.has(id));
      if (changed.length > 0) return { kind: "conflict", records: changed, why: "changed" };
      const existing = diff.absent.filter((id) => txn.get(id) !== undefined);
      if (existing.length > 0) return { kind: "conflict", records: existing, why: "exists" };
      if (diff.removes.length > 0) {
        // A record someone added meanwhile may point at what this diff
        // removes (an arrow bound to it, a shape dropped into it).
        const gone = new Set(diff.removes);
        const written = new Set(diff.puts.map((record) => record.id));
        const orphans = new Set<string>();
        for (const record of txn.values()) {
          if (gone.has(record.id) || written.has(record.id)) continue;
          for (const id of referencesOf(record)) if (gone.has(id)) orphans.add(record.id);
        }
        if (orphans.size > 0) return { kind: "conflict", records: [...orphans], why: "referenced" };
      }
      for (const record of diff.puts) txn.set(record.id, record);
      for (const id of diff.removes) txn.delete(id);
      return { clock: txn.getClock(), kind: "committed" };
    }).result;
    if (outcome.kind === "committed" && diff.run !== undefined && diff.run.created.length > 0) {
      this.remember(diff.run.id, diff.run.created, now);
    }
    return outcome;
  }
}

// A page's own records: every page (for their names and order), the
// page's shapes at any depth, and the bindings between them.
function onPage(records: TLRecord[], pageId: string): TLRecord[] {
  const parents = new Map<string, string>();
  for (const record of records) {
    if (record.typeName === "shape") parents.set(record.id, record.parentId);
  }
  const here = (id: string): boolean => {
    let parent = parents.get(id);
    for (let depth = 0; parent !== undefined && depth < 1_000; depth++) {
      if (parent === pageId) return true;
      parent = parents.get(parent);
    }
    return false;
  };
  return records.filter(
    (record) =>
      record.typeName === "page" ||
      record.typeName === "document" ||
      (record.typeName === "shape" && here(record.id)) ||
      (record.typeName === "binding" && here(record.fromId)),
  );
}
