import type { TLRecord } from "@tldraw/tlschema";

// The contract between the board's room and a Worker bound to it (the MCP
// Worker): what is asked, what is answered. Types only, so either side and
// the tests can import it without the other's runtime.

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

export type DocumentScope = "document" | { page: string };

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

// The room's calls as a Worker bound to its class makes them.
// NOTE: written out because the stub's inferred types recurse through every
// tldraw record type until TypeScript gives up.
export type RoomDocumentCalls = {
  commitDocument(
    grant: BoardGrant,
    diff: DocumentDiff,
  ): Promise<"read-only" | "revoked" | CommitOutcome>;
  readDocument(
    grant: BoardGrant,
    request: { runId?: string; scope: DocumentScope },
  ): Promise<"revoked" | DocumentSnapshot>;
  revokeMcpGrants(board: string, version: number): Promise<void>;
};
