import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import {
  DEFAULT_INITIAL_SNAPSHOT,
  DurableObjectSqliteSyncWrapper,
  type SessionStateSnapshot,
  SQLiteSyncStorage,
  TLSocketRoom,
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import { isShape, TLDOCUMENT_ID } from "@tldraw/tlschema";
import { sortByIndex } from "@tldraw/utils";
import { DurableObject } from "cloudflare:workers";

import type { ThumbnailType } from "./board-thumbnail";
import type { ExpressionError } from "./dice-expression";
import type { Roll, RollRequest } from "./dice-notation";
import type { Pass } from "./pass";
import type {
  BoardGrant,
  CommitOutcome,
  DocumentDiff,
  DocumentScope,
  DocumentSnapshot,
} from "./room-contract";
import type { SummonRequest } from "./summon";
import type { EngineKey } from "./text-result";

import { AVATAR, copyAvatar, hostRule, logAvatar } from "./avatars";
import { type BoardColor, isBoardColor } from "./board-palette";
import { type ChatMessage, rollCommand } from "./chat";
import { appendChat, openChat, recentChat } from "./chat-store";
import { addRollColumns, drawSeed, rollDie } from "./dice";
import { evaluateExpression } from "./dice-evaluation";
import { InvalidRoll, parseExpression } from "./dice-expression";
import { FileLedger, type FileRefusal, publicationKey, type StoredFile } from "./file-store";
import { AVATAR_RETRY_MS, MAX_PEOPLE, MIN_ROLL_INTERVAL_MS, ROLL_LOG_LENGTH } from "./limits";
import { stampPresence } from "./presence";
import {
  expirePublicShapes,
  preservesPublicShapeAge,
  PUBLIC_SWEEP_MS,
  publicFileReferences,
  separatePublicSiblingIndices,
  stampPublicShape,
} from "./public-board-expiry";
import {
  discardLandingPageDeletion,
  isPublicSignature,
  type LandingPageMessage,
  placePublicSignature,
  PUBLIC_SIGNATURE_GROUP,
} from "./public-signature";
import { openRoomAllowances } from "./room-allowance";
import { RoomDocument } from "./room-document";
import { isSecretLayer } from "./secret-layer";
import { AssistantGrants } from "./standalone/assistant-grants";
import { activeSessionExpiry } from "./standalone/store";
import {
  type Claim,
  type ClaimRequest,
  type Reading,
  type StoredText,
  TextLedger,
  type TextListing,
  type TextRefusal,
} from "./text-store";
import { type ThumbnailWrite, writeThumbnail } from "./thumbnail-store";

type Env = {
  BOARD_DATA_SCOPE?: string;
  BoardRoom: DurableObjectNamespace<BoardRoom>;
  DB?: D1Database;
  Files: R2Bucket;
};

export type Refusal = "full" | "link-reset" | "too-fast";

// WARNING: tldraw retries ordinary closes. Code 4099 passes the final reason to useSync.
const SOCKET_REFUSAL: Record<"full" | "link-reset", string> = {
  full: TLSyncErrorCloseEventReason.ROOM_FULL,
  "link-reset": TLSyncErrorCloseEventReason.FORBIDDEN,
};

/** Account board IDs are alphanumeric, so they cannot collide with this room name. */
export const PUBLIC_BOARD = "public-lobby";
const PUBLIC_EXPIRY_ENABLED = "publicExpiryEnabled";
const PUBLIC_LANDING_PAGE_NAMED = "publicLandingPageNamed";
const PUBLIC_ORDER_NORMALIZED = "publicOrderNormalized";
const PUBLIC_SIGNATURE_PAGE = "publicSignaturePage";
const RETIRED = "retired";
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_SNAPSHOT_PREFIX = "socketSnapshot:";
const PRIVATE_SESSION_CHECK_MS = 30_000;

export const PASS_HEADER = "X-Board-Pass";
export const AVATAR_HEADER = "X-Board-Avatar";

export type AvatarSource = { hostOrigin: string; mode: "hosted" } | { mode: "standalone" };

type Person = Pick<Pass, "link" | "name" | "owner" | "sessionHash" | "sub"> & {
  avatar: string | null;
};
type SocketAttachment = {
  sessionId: string;
  person: Person;
} & (
  | { snapshot?: SessionStateSnapshot; stored?: never }
  | { snapshot: SessionStateSnapshot; stored: true }
);
type RoomSocket = {
  socket: WebSocket;
  connectTimer?: ReturnType<typeof setTimeout>;
  snapshot?: SessionStateSnapshot;
  stored?: boolean;
};
type RollCompletion =
  | { refusal: Refusal }
  | { error: ExpressionError }
  | { roll: Roll; message: ChatMessage | null };

type DrawingRoom = { drawing: SQLiteSyncStorage<TLRecord>; room: TLSocketRoom<TLRecord, Person> };
type PublicDrawing = Extract<TLRecord, { typeName: "shape" }>;

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function kind(sub: string): "guest" | "member" {
  return sub.startsWith("g:") ? "guest" : "member";
}

export class BoardRoom extends DurableObject<Env> {
  private assistantGrantEpoch = 0;
  private document!: RoomDocument;
  private drawingRoom?: DrawingRoom;
  private readonly sockets = new Map<string, RoomSocket>();
  private readonly privateSessionDeadlines = new Map<string, number>();
  private publicExpiryEnabled = false;
  private publicSignaturePage?: TLPageId;
  private retired = false;
  private lastRollAt = new Map<string, number>();
  private files!: FileLedger;
  private texts!: TextLedger;
  private readonly textUploads = new Map<string, number>();
  private thumbnailPending = false;
  private readonly pendingUploads = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.open();
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    const sockets = ctx.getWebSockets();
    if (this.privateSessionHashes(sockets).size === 0) {
      this.restoreSockets(sockets);
    } else {
      void ctx.blockConcurrencyWhile(async () => {
        await this.recheckPrivateSessions(sockets);
        this.restoreSockets(sockets);
      });
    }
  }

  // WARNING: After deleteAll, the cached room still refers to rows whose tables were dropped.
  private open() {
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id = 1), link INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rolls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, dice TEXT NOT NULL, seed INTEGER, expression TEXT, outcome TEXT, chat INTEGER)",
    );
    addRollColumns(sql);
    this.ctx.storage.transactionSync(() => openChat(sql));
    openRoomAllowances(sql);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS people (sub TEXT PRIMARY KEY, source TEXT, avatar TEXT, checked_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mcp_grant (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    this.document = new RoomDocument(sql, () => this.drawing);
    this.publicExpiryEnabled = this.ctx.storage.kv.get(PUBLIC_EXPIRY_ENABLED) === true;
    this.publicSignaturePage = this.ctx.storage.kv.get<TLPageId>(PUBLIC_SIGNATURE_PAGE);
    this.retired = this.ctx.storage.kv.get(RETIRED) === true;
    this.drawingRoom = undefined;
    this.lastRollAt = new Map();
    // WARNING: The image ledger queries the texts table for its quota, so initialize that table first.
    this.texts = new TextLedger(sql, this.env.Files);
    this.files = new FileLedger(sql, this.env.Files);
  }

  private get drawing(): SQLiteSyncStorage<TLRecord> {
    return this.openDrawing().drawing;
  }

  private get room(): TLSocketRoom<TLRecord, Person> {
    return this.openDrawing().room;
  }

  // WARNING: Applying the seed name to existing drawings would overwrite a saved page name.
  private openDrawing(firstPageName?: string): DrawingRoom {
    if (this.drawingRoom !== undefined) return this.drawingRoom;
    const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage, { tablePrefix: "tldraw_" });
    const snapshot =
      firstPageName !== undefined && !SQLiteSyncStorage.hasBeenInitialized(sql)
        ? {
            ...DEFAULT_INITIAL_SNAPSHOT,
            documents: DEFAULT_INITIAL_SNAPSHOT.documents.map((record) =>
              record.state.typeName === "page"
                ? { ...record, state: { ...record.state, name: firstPageName } }
                : record,
            ),
          }
        : undefined;
    const drawing = new SQLiteSyncStorage<TLRecord>({ snapshot, sql });
    const { kv } = this.ctx.storage;
    if (this.publicExpiryEnabled && kv.get(PUBLIC_ORDER_NORMALIZED) !== true) {
      drawing.transaction(separatePublicSiblingIndices);
      kv.put(PUBLIC_ORDER_NORMALIZED, true);
    }
    const room = new TLSocketRoom<TLRecord, Person>({
      // WARNING: tldraw's periodic idle polling keeps the object awake even with no sockets.
      clientTimeout: Infinity,
      authorizeRecord: {
        shape: (write) => {
          const record = write.type === "delete" ? write.prev : write.next;
          if (!this.publicExpiryEnabled) return record;
          if (isPublicSignature(record.id) || record.parentId === PUBLIC_SIGNATURE_GROUP) {
            return null;
          }
          if (write.type === "delete") return record;
          if (write.type === "create") return stampPublicShape(record, Date.now());
          return preservesPublicShapeAge(write.prev, record) ? record : null;
        },
      },
      onCommittedChanges: ({ diff }) => {
        if (!this.publicExpiryEnabled) return;
        const parents = new Set<PublicDrawing["parentId"]>();
        const moved = new Set<PublicDrawing["id"]>();
        for (const put of Object.values(diff.puts)) {
          const [before, after] = Array.isArray(put) ? put : [undefined, put];
          if (
            after.typeName === "shape" &&
            (before?.typeName !== "shape" ||
              before.parentId !== after.parentId ||
              before.index !== after.index)
          ) {
            parents.add(after.parentId);
            moved.add(after.id);
          }
        }
        if (parents.size > 0) {
          drawing.transaction((store) => separatePublicSiblingIndices(store, parents, moved));
        }
      },
      // WARNING: The hook type omits the parsed message that tldraw applies to room state.
      onAfterReceiveMessage: (received) => {
        const { message } = received as typeof received & { message?: LandingPageMessage };
        stampPresence(message, received.meta);
        if (this.publicSignaturePage !== undefined) {
          discardLandingPageDeletion(message, this.publicSignaturePage);
        }
      },
      storage: drawing,
    });
    this.drawingRoom = { drawing, room };
    return this.drawingRoom;
  }

  initializeDrawing(firstPageName: string): void {
    this.openDrawing(firstPageName);
  }

  private link(): number {
    const [row] = this.ctx.storage.sql.exec("SELECT link FROM board").toArray();
    return row === undefined ? 0 : (row.link as number);
  }

  // WARNING: A fresh pass can arrive before the host notifies the room of a link reset.
  private admit(pass: Pass): "link-reset" | null {
    if (this.retired) return "link-reset";
    const current = this.link();
    if (pass.link < current) return "link-reset";
    if (pass.link > current) this.moveLink(pass.board, pass.link);
    return null;
  }

  /** Advances the link version and evicts sessions still using an older one. */
  moveLink(board: string, link: number): void {
    if (this.retired || link <= this.link()) return;
    this.assistantGrantsChanged();
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

  // WARNING: WebSockets cannot cross Durable Object RPC. Forward the upgrade request with the verified pass.
  override fetch(request: Request): Promise<Response> | Response {
    const pass: Pass = JSON.parse(request.headers.get(PASS_HEADER)!);
    if (!isSecretLayer(pass.board)) return this.connectRoom(request, pass);

    // WARNING: Keep authorization and acceptance in the same input gate as logout.
    return this.ctx.blockConcurrencyWhile(async () => {
      const hash = pass.sessionHash;
      if (hash === undefined || !(await this.checkPrivateSession(hash))) {
        return new Response("Forbidden", { status: 403 });
      }
      await this.schedulePrivateSessionCheck();
      if (!this.mayUseSocket(hash)) return new Response("Forbidden", { status: 403 });
      return this.connectRoom(request, pass);
    });
  }

  private privateSessionHashes(sockets: WebSocket[]) {
    const hashes = new Set<string>();
    for (const socket of sockets) {
      const saved = socket.deserializeAttachment() as SocketAttachment | null;
      const hash = saved?.person.sessionHash;
      if (socket.readyState === WebSocket.OPEN && hash !== undefined) hashes.add(hash);
    }
    return hashes;
  }

  private async checkPrivateSession(hash: string) {
    const started = Date.now();
    let expiry: number | null = null;
    try {
      expiry = await activeSessionExpiry(this.env.DB, hash);
    } catch {
      log("board.private_session_check_failed", {});
    }
    if (expiry === null || expiry <= Date.now()) {
      this.disconnectSession(hash);
      return false;
    }
    this.privateSessionDeadlines.set(
      hash,
      Math.min(expiry, started + 2 * PRIVATE_SESSION_CHECK_MS),
    );
    return true;
  }

  private async schedulePrivateSessionCheck() {
    if (this.privateSessionDeadlines.size === 0) return;
    const next = Math.min(
      Date.now() + PRIVATE_SESSION_CHECK_MS,
      ...this.privateSessionDeadlines.values(),
    );
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > next) await this.ctx.storage.setAlarm(next);
  }

  private async recheckPrivateSessions(sockets: WebSocket[]) {
    const hashes = this.privateSessionHashes(sockets);
    for (const hash of this.privateSessionDeadlines.keys()) {
      if (!hashes.has(hash)) this.privateSessionDeadlines.delete(hash);
    }
    await Promise.all([...hashes].map((hash) => this.checkPrivateSession(hash)));
    await this.schedulePrivateSessionCheck();
  }

  private mayUseSocket(hash: string | undefined) {
    return hash === undefined || (this.privateSessionDeadlines.get(hash) ?? 0) > Date.now();
  }

  private syncSocket(socket: WebSocket, hash: string | undefined) {
    // WARNING: Hibernatable WebSockets deliver events to the object instead of socket listeners.
    return {
      get readyState() {
        return socket.readyState;
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
      send: (message: string) => {
        if (this.mayUseSocket(hash)) socket.send(message);
        else socket.close(TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason.FORBIDDEN);
      },
    };
  }

  disconnectSession(hash: string): void {
    this.privateSessionDeadlines.delete(hash);
    const room = this.drawingRoom?.room;
    if (room === undefined) return;
    for (const session of room.getSessions()) {
      if (session.meta.sessionHash === hash) {
        room.closeSession(session.sessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
      }
    }
  }

  private connectRoom(request: Request, pass: Pass): Response {
    const avatar = request.headers.get(AVATAR_HEADER) || null;
    const sessionId = new URL(request.url).searchParams.get("sessionId")!;
    const refusal =
      this.admit(pass) ?? (this.room.getNumActiveSessions() >= MAX_PEOPLE ? "full" : null);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (refusal !== null) {
      log("board.refused", { board: pass.board, person: kind(pass.sub), reason: refusal });
      server.close(
        TLSyncErrorCloseEventCode,
        this.retired ? TLSyncErrorCloseEventReason.NOT_FOUND : SOCKET_REFUSAL[refusal],
      );
      return new Response(null, { status: 101, webSocket: client });
    }
    const person: Person = {
      avatar,
      link: pass.link,
      name: pass.name,
      owner: pass.owner,
      sessionHash: isSecretLayer(pass.board) ? pass.sessionHash : undefined,
      sub: pass.sub,
    };
    const previous = this.sockets.get(sessionId);
    if (previous !== undefined) {
      clearTimeout(previous.connectTimer);
      if (previous.stored === true) this.ctx.storage.kv.delete(SOCKET_SNAPSHOT_PREFIX + sessionId);
      previous.socket.close(1012, "Session replaced");
    }
    server.serializeAttachment({ sessionId, person } satisfies SocketAttachment);
    this.sockets.set(sessionId, {
      socket: server,
      connectTimer: setTimeout(() => this.room.closeSession(sessionId), CONNECT_TIMEOUT_MS),
    });
    this.room.handleSocketConnect({
      meta: person,
      sessionId,
      socket: this.syncSocket(server, person.sessionHash),
    });
    log("board.connected", {
      board: pass.board,
      people: this.room.getNumActiveSessions(),
      person: kind(pass.sub),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private restoreSockets(sockets: WebSocket[]) {
    const { kv } = this.ctx.storage;
    const unused = new Map(kv.list<SessionStateSnapshot>({ prefix: SOCKET_SNAPSHOT_PREFIX }));
    const link = sockets.length === 0 ? 0 : this.link();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const saved = socket.deserializeAttachment() as SocketAttachment | null;
      if (saved === null) continue;
      if (
        this.retired ||
        saved.person.link < link ||
        !this.mayUseSocket(saved.person.sessionHash)
      ) {
        socket.close(
          TLSyncErrorCloseEventCode,
          this.retired
            ? TLSyncErrorCloseEventReason.NOT_FOUND
            : TLSyncErrorCloseEventReason.FORBIDDEN,
        );
      } else {
        const key = SOCKET_SNAPSHOT_PREFIX + saved.sessionId;
        const inStorage = saved.stored === true;
        const snapshot = inStorage ? unused.get(key) : saved.snapshot;
        if (snapshot === undefined) {
          socket.close(1012, "Reconnecting");
          continue;
        }
        if (inStorage) unused.delete(key);
        this.sockets.set(saved.sessionId, { socket, snapshot, stored: inStorage });
        this.room.handleSocketResume({
          sessionId: saved.sessionId,
          socket: this.syncSocket(socket, saved.person.sessionHash),
          meta: saved.person,
          snapshot,
        });
      }
    }
    for (const key of unused.keys()) kv.delete(key);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const saved = socket.deserializeAttachment() as SocketAttachment | null;
    if (saved === null) return;
    const connection = this.sockets.get(saved.sessionId);
    if (connection?.socket !== socket) return;
    if (!this.mayUseSocket(saved.person.sessionHash)) {
      this.room.closeSession(saved.sessionId, TLSyncErrorCloseEventReason.FORBIDDEN);
      return;
    }
    this.room.handleSocketMessage(saved.sessionId, message);
    const compact = this.room.getSessionSnapshot(saved.sessionId);
    if (compact === null) return;
    clearTimeout(connection.connectTimer);
    connection.connectTimer = undefined;
    // WARNING: Peers already have the full presence record and the next client patch is relative to it.
    const snapshot = { ...compact };
    if (compact.presenceId !== null) {
      const room = this.room as TLSocketRoom<TLRecord, Person> & {
        getPresenceRecords(): Record<string, TLRecord>;
      };
      snapshot.presenceRecord = room.getPresenceRecords()[compact.presenceId] ?? null;
    }
    const previous = connection.snapshot;
    if (
      previous?.serializedSchema === snapshot.serializedSchema &&
      previous.presenceRecord === snapshot.presenceRecord
    )
      return;
    const { person, sessionId } = saved;
    const key = SOCKET_SNAPSHOT_PREFIX + sessionId;
    const { kv } = this.ctx.storage;
    try {
      socket.serializeAttachment({ person, sessionId, snapshot } satisfies SocketAttachment);
      if (connection.stored === true) {
        kv.delete(key);
        connection.stored = false;
      }
    } catch {
      try {
        kv.put(key, snapshot);
        connection.stored = true;
        socket.serializeAttachment({
          person,
          sessionId,
          snapshot: compact,
          stored: true,
        } satisfies SocketAttachment);
      } catch {
        this.room.closeSession(sessionId, TLSyncErrorCloseEventReason.UNKNOWN_ERROR);
        return;
      }
    }
    connection.snapshot = snapshot;
  }

  override webSocketClose(socket: WebSocket) {
    const saved = socket.deserializeAttachment() as SocketAttachment | null;
    if (saved === null) return;
    const { person, sessionId, snapshot } = saved;
    const connection = this.sockets.get(sessionId);
    if (connection === undefined) {
      // WARNING: A disconnect can wake the room after getWebSockets has already dropped that socket.
      if (snapshot?.presenceRecord == null) return;
      this.room.handleSocketResume({
        sessionId,
        socket: this.syncSocket(socket, person.sessionHash),
        meta: person,
        snapshot,
      });
    } else {
      if (connection.socket !== socket) return;
      clearTimeout(connection.connectTimer);
      if (connection.stored === true) {
        this.ctx.storage.kv.delete(SOCKET_SNAPSHOT_PREFIX + sessionId);
      }
      this.sockets.delete(sessionId);
    }
    this.room.handleSocketClose(sessionId);
  }

  override webSocketError(socket: WebSocket) {
    this.webSocketClose(socket);
  }

  roll(pass: Pass, request: RollRequest) {
    const result = this.rollWithChat(pass, request);
    if ("refusal" in result) return result.refusal;
    return "error" in result ? result : result.roll;
  }

  private rollWithChat: (pass: Pass, request: RollRequest, inChat?: boolean) => RollCompletion = (
    pass,
    request,
    inChat = false,
  ) => {
    const refusal = this.admit(pass);
    if (refusal !== null) return { refusal };
    const expression = "expression" in request ? request.expression : undefined;
    const formula = expression === undefined ? null : parseExpression(expression);
    if (formula !== null && "error" in formula) return formula;
    const at = Date.now();
    if (at - (this.lastRollAt.get(pass.sub) ?? 0) < MIN_ROLL_INTERVAL_MS)
      return { refusal: "too-fast" };
    this.lastRollAt.set(pass.sub, at);

    let dice: Roll["dice"];
    let outcome: Roll["outcome"];
    try {
      if ("dice" in request) dice = request.dice.map((sides) => ({ sides, value: rollDie(sides) }));
      else ({ dice, outcome } = evaluateExpression(formula!, rollDie));
    } catch (error) {
      if (error instanceof InvalidRoll) return { error: error.reason };
      throw error;
    }

    const { storage } = this.ctx;
    const { sql } = storage;
    const seed = drawSeed();
    const launch = "launch" in request ? request.launch : undefined;
    const text = expression?.trim();
    const { name, sub } = pass;
    const { roll, message } = storage.transactionSync(() => {
      const row = sql
        .exec(
          "INSERT INTO rolls (at, sub, name, dice, seed, expression, outcome, chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
          at,
          sub,
          name,
          JSON.stringify(dice),
          seed,
          text ?? null,
          outcome === undefined ? null : JSON.stringify(outcome),
          inChat ? 1 : null,
        )
        .one();
      const roll: Roll = { at, dice, id: Number(row.id), name, seed, sub };
      if (inChat) roll.chat = true;
      if (text !== undefined) roll.expression = text;
      if (launch !== undefined) roll.launch = launch;
      if (outcome !== undefined) roll.outcome = outcome;
      sql.exec("DELETE FROM rolls WHERE id <= ?", roll.id - ROLL_LOG_LENGTH);
      const message =
        inChat && text !== undefined && outcome !== undefined
          ? appendChat(sql, { at, name, sub, text, diceTotal: outcome.total })
          : null;
      return { roll, message };
    });
    for (const session of this.room.getSessions()) {
      this.room.sendCustomMessage(session.sessionId, { roll, type: "roll" });
    }
    if (message !== null) this.announceChat(message);
    log("board.rolled", { board: pass.board, dice: dice.length, person: kind(pass.sub) });
    return { roll, message };
  };

  summon(pass: Pass, { target, ...view }: SummonRequest) {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const { room } = this;
    if (room.getRecord(view.page)?.typeName !== "page") return "page-missing" as const;
    const recipients = room
      .getSessions()
      .filter(
        (session) => session.isConnected && session.meta.sub === target && target !== pass.sub,
      );
    for (const session of recipients) {
      room.sendCustomMessage(session.sessionId, { ...view, type: "summon" });
    }
    return recipients.length === 0 ? ("participant-missing" as const) : null;
  }

  rolls(pass: Pass): Refusal | Roll[] {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    return this.ctx.storage.sql
      .exec(
        "SELECT id, at, sub, name, dice, seed, expression, outcome, chat FROM rolls ORDER BY id",
      )
      .toArray()
      .map((row) => {
        const roll: Roll = {
          at: Number(row.at),
          dice: JSON.parse(String(row.dice)),
          id: Number(row.id),
          name: String(row.name),
          seed: row.seed === null ? null : Number(row.seed),
          sub: String(row.sub),
        };
        if (row.chat === 1) roll.chat = true;
        if (row.expression !== null) roll.expression = String(row.expression);
        if (row.outcome !== null) roll.outcome = JSON.parse(String(row.outcome));
        return roll;
      });
  }

  chatHistory(pass: Pass): ChatMessage[] | Refusal {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    return recentChat(this.ctx.storage.sql);
  }

  sendChat(pass: Pass, text: string) {
    const expression = rollCommand(text);
    if (expression !== null) {
      const result = this.rollWithChat(pass, { expression }, true);
      if ("refusal" in result) return result.refusal;
      return "error" in result ? result : result.message!;
    }

    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const { storage } = this.ctx;
    const { name, sub } = pass;
    const message = storage.transactionSync(() =>
      appendChat(storage.sql, { at: Date.now(), name, sub, text }),
    );
    this.announceChat(message);
    return message;
  }

  private announceChat(message: ChatMessage) {
    for (const session of this.room.getSessions()) {
      this.room.sendCustomMessage(session.sessionId, { message, type: "chat" });
    }
  }

  /**
   * Returns the stored avatar hash. A host-signed pass can request a fresh copy
   * from its own origin when the URL changes or the failure cooldown elapses.
   */
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

  hasAvatar(hash: string): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM people WHERE avatar = ?", hash).toArray().length > 0
    );
  }

  fileAccess(pass: Pass): "link-reset" | null {
    return this.admit(pass);
  }

  async storeFile(pass: Pass, body: ArrayBuffer): Promise<"link-reset" | FileRefusal | StoredFile> {
    return this.admit(pass) ?? this.trackUpload(this.files.store(pass.board, pass.sub, body));
  }

  backgroundForSharePreview(link: number): BoardColor | null {
    if (this.retired || link < this.link()) return null;
    return this.drawing.transaction((store) => {
      const background = store.get(TLDOCUMENT_ID)?.meta.backgroundColor;
      return isBoardColor(background) ? background : "default";
    }).result;
  }

  publicationCode() {
    return this.ctx.storage.kv.get<string>("publicationCode") ?? null;
  }

  async setPublication(board: string, image: ArrayBuffer | null) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.retired) return null;
      const current = this.publicationCode();
      if (image === null) {
        if (current !== null) await this.env.Files.delete(publicationKey(board, current));
        this.ctx.storage.kv.delete("publicationCode");
        return null;
      }
      const code = current ?? crypto.randomUUID();
      await this.env.Files.put(publicationKey(board, code), image, {
        httpMetadata: { contentType: "image/png" },
      });
      this.ctx.storage.kv.put("publicationCode", code);
      return code;
    });
  }

  async storeThumbnail(
    board: string,
    link: number,
    body: ArrayBuffer,
    type: ThumbnailType,
  ): Promise<ThumbnailWrite> {
    if (this.retired || link < this.link()) return "forbidden";
    if (this.thumbnailPending) return { retryAt: Date.now() + 5000 };
    if (link > this.link()) this.moveLink(board, link);
    this.thumbnailPending = true;
    try {
      return await this.trackUpload(
        writeThumbnail(this.ctx.storage.sql, this.env.Files, board, body, type, Date.now()),
      );
    } finally {
      this.thumbnailPending = false;
    }
  }

  private async trackUpload<T>(upload: Promise<T>): Promise<T> {
    this.pendingUploads.add(upload);
    try {
      return await upload;
    } finally {
      this.pendingUploads.delete(upload);
    }
  }

  private announceText(readings: Reading[], state: "idle" | "reading" | "stored"): void {
    if (readings.length === 0) return;
    for (const session of this.room.getSessions()) {
      this.room.sendCustomMessage(session.sessionId, { readings, state, type: "image-text" });
    }
  }

  textListing(pass: Pass): "link-reset" | TextListing {
    return this.admit(pass) ?? this.texts.listing();
  }

  claimText(pass: Pass, request: ClaimRequest): Claim | Refusal | null {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const claim = this.texts.claim(pass.sub, request);
    if (claim !== null && claim !== "too-fast") {
      this.announceText(
        claim.engines.map((engine) => ({ engine, hash: claim.hash })),
        "reading",
      );
    }
    return claim;
  }

  renewText(pass: Pass, lease: string): "link-reset" | boolean {
    return this.admit(pass) ?? this.texts.renew(pass.sub, lease);
  }

  releaseText(pass: Pass, lease: string, failed: EngineKey[]): "link-reset" | null {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    this.announceText(this.texts.release(pass.sub, lease, failed), "idle");
    return null;
  }

  async storeText(
    pass: Pass,
    { engine, hash }: Reading,
    body: ArrayBuffer,
  ): Promise<"link-reset" | StoredText | TextRefusal | { problem: string; refusal: "invalid" }> {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    this.textUploads.set(hash, (this.textUploads.get(hash) ?? 0) + 1);
    try {
      const stored = await this.trackUpload(
        this.texts.store({ board: pass.board, engine, hash, sub: pass.sub }, body, {
          bytesNow: () => this.files.storedBytes(),
        }),
      );
      if (typeof stored === "object" && "body" in stored && !stored.duplicate) {
        this.announceText([{ engine, hash }], "stored");
      }
      return stored;
    } finally {
      const remaining = (this.textUploads.get(hash) ?? 1) - 1;
      if (remaining === 0) this.textUploads.delete(hash);
      else this.textUploads.set(hash, remaining);
    }
  }

  private preparePublicLandingPage(): void {
    const { kv } = this.ctx.storage;
    if (this.publicSignaturePage !== undefined) return;
    const namePage = kv.get(PUBLIC_LANDING_PAGE_NAMED) !== true;
    const page = this.drawing.transaction((store) => {
      const first = [...store.values()]
        .filter((record) => record.typeName === "page")
        .sort(sortByIndex)[0];
      if (first === undefined) return;
      if (namePage && first.name !== "Landing Page") {
        store.set(first.id, { ...first, name: "Landing Page" });
      }
      placePublicSignature(store, first.id);
      return first.id;
    }).result;
    if (page !== undefined) {
      kv.put(PUBLIC_LANDING_PAGE_NAMED, true);
      kv.put(PUBLIC_SIGNATURE_PAGE, page);
      this.publicSignaturePage = page;
    }
  }

  async schedulePublicExpiry(): Promise<void> {
    this.preparePublicLandingPage();
    if (!this.publicExpiryEnabled) {
      // WARNING: Stamp existing shapes when enabling expiry so drawings without a timestamp can expire.
      const now = Date.now();
      this.drawing.transaction((store) => {
        separatePublicSiblingIndices(store);
        // WARNING: Materialize these SQLite rows before updating the table they came from.
        const records = [...store.values()];
        for (const record of records) {
          if (isShape(record) && !isPublicSignature(record.id)) {
            store.set(record.id, stampPublicShape(record, now));
          }
        }
      });
      this.ctx.storage.kv.put(PUBLIC_EXPIRY_ENABLED, true);
      this.ctx.storage.kv.put(PUBLIC_ORDER_NORMALIZED, true);
      this.publicExpiryEnabled = true;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      const next = (Math.floor(Date.now() / PUBLIC_SWEEP_MS) + 1) * PUBLIC_SWEEP_MS;
      await this.ctx.storage.setAlarm(next);
    }
  }

  override async alarm(): Promise<void> {
    if (!this.publicExpiryEnabled) {
      await this.ctx.blockConcurrencyWhile(() =>
        this.recheckPrivateSessions(this.ctx.getWebSockets()),
      );
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const { assetsByHash, live } = this.drawing.transaction((store) => {
        expirePublicShapes(store, now);
        return publicFileReferences(store.values(), PUBLIC_BOARD);
      }).result;
      const reclaimed = await this.files.reclaimUnused(
        PUBLIC_BOARD,
        live,
        now,
        PUBLIC_SWEEP_MS,
        (hash) => this.textUploads.has(hash),
      );
      this.drawing.transaction((store) => {
        for (const hash of reclaimed) {
          for (const id of assetsByHash.get(hash) ?? []) store.delete(id);
        }
      });
      await this.schedulePublicExpiry();
    });
  }

  async retire(board: string): Promise<void> {
    // WARNING: Without the retired marker, a still-valid pass could reopen the deleted private room.
    this.retired = true;
    this.ctx.storage.kv.put(RETIRED, true);
    await this.destroy(board);
  }

  private grantVersion() {
    const [row] = this.ctx.storage.sql
      .exec<{ version: number }>("SELECT version FROM mcp_grant")
      .toArray();
    return row?.version ?? 0;
  }

  private setGrantVersion(version: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO mcp_grant (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version",
      version,
    );
  }

  private async withDocumentGrant<T>(grant: BoardGrant, apply: () => T): Promise<"revoked" | T> {
    if (this.retired) return "revoked";
    if (grant.standalone !== undefined) {
      const epoch = this.assistantGrantEpoch;
      if (
        !this.env.DB ||
        !(await new AssistantGrants(this.env.DB, this.env.BOARD_DATA_SCOPE).admits(grant))
      )
        return "revoked";
      // WARNING: A stale D1 result can arrive after revocation, a link reset, or deletion.
      return this.assistantGrantEpoch === epoch ? apply() : "revoked";
    }
    const current = this.grantVersion();
    if (grant.role !== "manager" && grant.role !== "owner") return "revoked";
    if (grant.grant < current) return "revoked";
    if (grant.grant > current) this.setGrantVersion(grant.grant);
    return apply();
  }

  /** The host revokes every assistant grant signed before this version. */
  revokeMcpGrants(board: string, version: number) {
    if (version <= this.grantVersion()) return;
    this.setGrantVersion(version);
    log("board.mcp_revoked", { board, version });
  }

  assistantGrantsChanged() {
    this.assistantGrantEpoch++;
  }

  /** Revokes existing hosted grants and returns the minimum grant version. */
  endAssistants(board: string) {
    this.assistantGrantsChanged();
    const version = this.grantVersion() + 1;
    this.revokeMcpGrants(board, version);
    return version;
  }

  readDocument(
    grant: BoardGrant,
    request: { runId?: string; scope: DocumentScope },
  ): Promise<"revoked" | DocumentSnapshot> {
    return this.withDocumentGrant(grant, () => this.document.read(request.scope, request.runId));
  }

  commitDocument(
    grant: BoardGrant,
    diff: DocumentDiff,
  ): Promise<"read-only" | "revoked" | CommitOutcome> {
    return this.withDocumentGrant(grant, () => {
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
    });
  }

  async destroy(board: string) {
    this.assistantGrantsChanged();
    for (const session of this.room.getSessions()) {
      this.room.closeSession(session.sessionId, TLSyncErrorCloseEventReason.NOT_FOUND);
    }
    this.room.close();
    for (const connection of this.sockets.values()) clearTimeout(connection.connectTimer);
    this.sockets.clear();
    // WARNING: Keep the document intact so deletion can be retried after a file storage error.
    let files: number;
    try {
      if (this.retired) await Promise.allSettled(this.pendingUploads);
      files = await this.files.wipe(board);
    } catch (error) {
      this.open();
      throw error;
    }
    const cleared = this.ctx.storage.deleteAll();
    if (this.retired) this.ctx.storage.kv.put(RETIRED, true);
    await cleared;
    this.open();
    log("board.deleted", { board, files });
  }
}
