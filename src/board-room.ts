import type { TLRecord } from "@tldraw/tlschema";

import {
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import { DurableObject } from "cloudflare:workers";

import type { Pass } from "./pass";
import type {
  BoardGrant,
  CommitOutcome,
  DocumentDiff,
  DocumentScope,
  DocumentSnapshot,
} from "./room-contract";

import { AVATAR, copyAvatar, hostRule, logAvatar } from "./avatars";
import { addSeedColumn, drawSeed, type Roll, rollDie } from "./dice";
import { FileLedger, type FileRefusal, type StoredFile } from "./file-store";
import { AVATAR_RETRY_MS, MAX_PEOPLE, MIN_ROLL_INTERVAL_MS, ROLL_LOG_LENGTH } from "./limits";
import { stampPresence } from "./presence";
import { RoomDocument } from "./room-document";

type Env = { BoardRoom: DurableObjectNamespace<BoardRoom>; Files: R2Bucket };

export type Refusal = "full" | "link-reset" | "too-fast";

// NOTE: the tldraw client reads close code 4099 as final and hands the
// reason to useSync as a TLRemoteSyncError, instead of retrying.
const SOCKET_REFUSAL: Record<"full" | "link-reset", string> = {
  full: TLSyncErrorCloseEventReason.ROOM_FULL,
  "link-reset": TLSyncErrorCloseEventReason.FORBIDDEN,
};

export const PASS_HEADER = "X-Board-Pass";
// The person's picture as personAvatar settled it, beside the pass.
export const AVATAR_HEADER = "X-Board-Avatar";

// Where a pass's picture comes from: in hosted mode a URL on the host's
// origin, which the room copies; in standalone mode the hash of the copy
// the Worker made at sign-in.
export type AvatarSource = { hostOrigin: string; mode: "hosted" } | { mode: "standalone" };

type Person = Pick<Pass, "link" | "name" | "owner" | "sub"> & { avatar: string | null };

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function kind(sub: string): "guest" | "member" {
  return sub.startsWith("g:") ? "guest" : "member";
}

export class BoardRoom extends DurableObject<Env> {
  private room!: TLSocketRoom<TLRecord, Person>;
  private lastRollAt = new Map<string, number>();
  private files!: FileLedger;
  private document!: RoomDocument;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.open();
  }

  // NOTE: deleteAll drops the tables and leaves the old room holding rows
  // that no longer exist, so deleting starts over from here.
  private open() {
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id = 1), link INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rolls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, dice TEXT NOT NULL)",
    );
    addSeedColumn(sql);
    // Everyone who has been on the board with a picture, so the board shows
    // those pictures and no others: source is what their pass named,
    // avatar the hash of the copy (null if it could not be copied).
    sql.exec(
      "CREATE TABLE IF NOT EXISTS people (sub TEXT PRIMARY KEY, source TEXT, avatar TEXT, checked_at INTEGER NOT NULL)",
    );
    this.room = new TLSocketRoom<TLRecord, Person>({
      // NOTE: tldraw leaves the parsed message out of this hook's public
      // type; it is the object the room then applies.
      onAfterReceiveMessage: (received) => {
        stampPresence((received as { message?: unknown }).message, received.meta);
      },
      storage: new SQLiteSyncStorage({
        sql: new DurableObjectSqliteSyncWrapper(this.ctx.storage, { tablePrefix: "tldraw_" }),
      }),
    });
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_grant (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    this.lastRollAt = new Map();
    this.files = new FileLedger(sql, this.env.Files);
    this.document = new RoomDocument(sql, () => this.room.storage);
  }

  private link(): number {
    const [row] = this.ctx.storage.sql.exec("SELECT link FROM board").toArray();
    return row === undefined ? 0 : (row.link as number);
  }

  // A reset link carries a higher version. The first pass that shows it
  // moves the board on and puts out everyone who came in by the old link.
  private admit(pass: Pass): "link-reset" | null {
    const current = this.link();
    if (pass.link < current) return "link-reset";
    if (pass.link > current) this.moveLink(pass.board, pass.link);
    return null;
  }

  // Moves the board to a newer link version and puts out everyone who came
  // in by an older one. Standalone mode calls it as the owner resets the
  // link; a host's newer pass does the same on arrival.
  moveLink(board: string, link: number): void {
    if (link <= this.link()) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO board (id, link) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET link = excluded.link",
      link,
    );
    for (const session of this.room.getSessions()) {
      if (session.meta.link < link) {
        this.room.closeSession(session.sessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
      }
    }
    log("board.link_reset", { board, link });
  }

  // NOTE: a socket cannot cross an RPC call, so the Worker forwards the
  // upgrade as a request and names the verified pass in PASS_HEADER.
  override fetch(request: Request): Response {
    const pass: Pass = JSON.parse(request.headers.get(PASS_HEADER)!);
    const avatar = request.headers.get(AVATAR_HEADER) || null;
    const sessionId = new URL(request.url).searchParams.get("sessionId")!;
    const refusal =
      this.admit(pass) ?? (this.room.getNumActiveSessions() >= MAX_PEOPLE ? "full" : null);
    if (refusal !== null) {
      log("board.refused", { board: pass.board, person: kind(pass.sub), reason: refusal });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.close(TLSyncErrorCloseEventCode, SOCKET_REFUSAL[refusal]);
      return new Response(null, { status: 101, webSocket: client });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.room.handleSocketConnect({
      meta: { avatar, link: pass.link, name: pass.name, owner: pass.owner, sub: pass.sub },
      sessionId,
      socket: server,
    });
    log("board.connected", {
      board: pass.board,
      people: this.room.getNumActiveSessions(),
      person: kind(pass.sub),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  roll(pass: Pass, pool: number[]): Refusal | Roll {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const at = Date.now();
    if (at - (this.lastRollAt.get(pass.sub) ?? 0) < MIN_ROLL_INTERVAL_MS) return "too-fast";
    this.lastRollAt.set(pass.sub, at);
    const dice = pool.map((sides) => ({ sides, value: rollDie(sides) }));
    const seed = drawSeed();
    const [row] = this.ctx.storage.sql
      .exec(
        "INSERT INTO rolls (at, sub, name, dice, seed) VALUES (?, ?, ?, ?, ?) RETURNING id",
        at,
        pass.sub,
        pass.name,
        JSON.stringify(dice),
        seed,
      )
      .toArray();
    const roll: Roll = { at, dice, id: row!.id as number, name: pass.name, seed, sub: pass.sub };
    this.ctx.storage.sql.exec("DELETE FROM rolls WHERE id <= ?", roll.id - ROLL_LOG_LENGTH);
    for (const session of this.room.getSessions()) {
      this.room.sendCustomMessage(session.sessionId, { roll, type: "roll" });
    }
    log("board.rolled", { board: pass.board, dice: pool.length, person: kind(pass.sub) });
    return roll;
  }

  rolls(pass: Pass): Refusal | Roll[] {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    return this.ctx.storage.sql
      .exec("SELECT id, at, sub, name, dice, seed FROM rolls ORDER BY id")
      .toArray()
      .map((row) => ({
        at: row.at as number,
        dice: JSON.parse(row.dice as string),
        id: row.id as number,
        name: row.name as string,
        seed: row.seed as number | null,
        sub: row.sub as string,
      }));
  }

  // The picture the board shows for this pass's person: the hash of its
  // copy in R2, or null. A host's picture is copied the first time a pass
  // names it, again when the pass names another, and, after a failure,
  // no sooner than AVATAR_RETRY_MS later; only a host-signed pass can make
  // the room fetch, and only from the host's origin.
  async personAvatar(pass: Pass, source: AvatarSource): Promise<string | null> {
    if (this.admit(pass) !== null) return null;
    const { sql } = this.ctx.storage;
    const [known] = sql
      .exec("SELECT source, avatar, checked_at FROM people WHERE sub = ?", pass.sub)
      .toArray();
    const now = Date.now();
    let avatar: string | null = null;
    if (pass.avatar === null) {
      if (known === undefined) return null;
    } else if (source.mode === "standalone") {
      avatar = AVATAR.test(pass.avatar) ? pass.avatar : null;
    } else if (
      known?.source === pass.avatar &&
      (known.avatar !== null || now - (known.checked_at as number) < AVATAR_RETRY_MS)
    ) {
      return known.avatar as string | null;
    } else {
      const copy = await copyAvatar({
        bucket: this.env.Files,
        rule: hostRule(source.hostOrigin),
        url: pass.avatar,
      });
      logAvatar({ copy, mode: "hosted", person: kind(pass.sub) });
      avatar = "hash" in copy ? copy.hash : null;
    }
    sql.exec(
      "INSERT INTO people (sub, source, avatar, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT (sub) DO UPDATE SET source = excluded.source, avatar = excluded.avatar, checked_at = excluded.checked_at",
      pass.sub,
      pass.avatar,
      avatar,
      now,
    );
    return avatar;
  }

  // Whether someone on this board has this picture.
  hasAvatar(hash: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM people WHERE avatar = ?", hash).toArray().length > 0
    );
  }

  // Whether this pass may read the board's images.
  fileAccess(pass: Pass): "link-reset" | null {
    return this.admit(pass);
  }

  async storeFile(pass: Pass, body: ArrayBuffer): Promise<"link-reset" | FileRefusal | StoredFile> {
    return this.admit(pass) ?? this.files.store(pass.board, pass.sub, body);
  }

  private grantVersion(): number {
    const [row] = this.ctx.storage.sql.exec("SELECT version FROM mcp_grant").toArray();
    return row === undefined ? 0 : (row.version as number);
  }

  private setGrantVersion(version: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO mcp_grant (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version",
      version,
    );
  }

  // As with links: a grant older than the board's grant version was revoked;
  // a newer one moves the board on.
  private admitGrant(grant: BoardGrant): "revoked" | null {
    const current = this.grantVersion();
    // NOTE: the caller verified the token; the rule is checked here too, so
    // no Worker bound to the room can act for someone who is not a shaman.
    if (grant.role !== "shaman" && grant.role !== "owner") return "revoked";
    if (grant.grant < current) return "revoked";
    if (grant.grant > current) this.setGrantVersion(grant.grant);
    return null;
  }

  // The host revokes every assistant grant on this board signed before
  // `version`, at once, without waiting for those tokens to expire.
  revokeMcpGrants(board: string, version: number): void {
    if (version <= this.grantVersion()) return;
    this.setGrantVersion(version);
    log("board.mcp_revoked", { board, version });
  }

  // Ends every assistant connected to this board at once (a shaman was
  // demoted, or the owner wants them gone). Returns the grant version that
  // later tokens must carry.
  endAssistants(board: string): number {
    const version = this.grantVersion() + 1;
    this.revokeMcpGrants(board, version);
    return version;
  }

  // NOTE: only a Worker bound to this class can call these; the caller has
  // verified the grant's token, the room checks its version and access.
  readDocument(
    grant: BoardGrant,
    request: { runId?: string; scope: DocumentScope },
  ): "revoked" | DocumentSnapshot {
    return this.admitGrant(grant) ?? this.document.read(request.scope, request.runId);
  }

  commitDocument(grant: BoardGrant, diff: DocumentDiff): "read-only" | "revoked" | CommitOutcome {
    const refusal = this.admitGrant(grant);
    if (refusal !== null) return refusal;
    if (grant.access !== "write") return "read-only";
    const outcome = this.document.commit(diff);
    log("board.document_commit", {
      board: grant.board,
      outcome: outcome.kind,
      people: this.room.getNumActiveSessions(),
      puts: diff.puts.length,
      removes: diff.removes.length,
    });
    return outcome;
  }

  async destroy(board: string) {
    for (const session of this.room.getSessions()) {
      this.room.closeSession(session.sessionId, TLSyncErrorCloseEventReason.NOT_FOUND);
    }
    this.room.close();
    // NOTE: the images go first: if that fails the board's document is
    // still there, the room opens again, and deleting again finishes.
    let files: number;
    try {
      files = await this.files.wipe(board);
    } catch (error) {
      this.open();
      throw error;
    }
    await this.ctx.storage.deleteAll();
    this.open();
    log("board.deleted", { board, files });
  }
}
