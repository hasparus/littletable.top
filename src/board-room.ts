import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import {
  DEFAULT_INITIAL_SNAPSHOT,
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import { isShape, TLDOCUMENT_ID } from "@tldraw/tlschema";
import { sortByIndex } from "@tldraw/utils";
import { DurableObject } from "cloudflare:workers";

import type { ThumbnailType } from "./board-thumbnail";
import type { DiceLaunch, Roll } from "./dice-notation";
import type { Pass } from "./pass";
import type { EngineKey } from "./text-result";

import { AVATAR, copyAvatar, hostRule, logAvatar } from "./avatars";
import { type BoardColor, isBoardColor } from "./board-palette";
import { CHAT_HISTORY_LENGTH, type ChatMessage } from "./chat";
import { addRollColumns, drawSeed, rollDie } from "./dice";
import { FileLedger, type FileRefusal, publicationKey, type StoredFile } from "./file-store";
import { AVATAR_RETRY_MS, MAX_PEOPLE, MIN_ROLL_INTERVAL_MS, ROLL_LOG_LENGTH } from "./limits";
import { stampPresence } from "./presence";
import {
  expirePublicShapes,
  preservesPublicShapeAge,
  PUBLIC_SWEEP_MS,
  publicFileReferences,
  stampPublicShape,
} from "./public-board-expiry";
import {
  discardLandingPageDeletion,
  isPublicSignature,
  type LandingPageMessage,
  placePublicSignature,
  PUBLIC_SIGNATURE_GROUP,
} from "./public-signature";
import { isSecretLayer } from "./secret-layer";
import { hasActiveSession } from "./standalone/store";
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

type Env = { BoardRoom: DurableObjectNamespace<BoardRoom>; DB?: D1Database; Files: R2Bucket };

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
const PUBLIC_SIGNATURE_PAGE = "publicSignaturePage";
const RETIRED = "retired";

export const PASS_HEADER = "X-Board-Pass";
export const AVATAR_HEADER = "X-Board-Avatar";

export type AvatarSource = { hostOrigin: string; mode: "hosted" } | { mode: "standalone" };

type Person = Pick<Pass, "link" | "name" | "owner" | "sessionHash" | "sub"> & {
  avatar: string | null;
};
type DrawingRoom = { drawing: SQLiteSyncStorage<TLRecord>; room: TLSocketRoom<TLRecord, Person> };

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function kind(sub: string): "guest" | "member" {
  return sub.startsWith("g:") ? "guest" : "member";
}

export class BoardRoom extends DurableObject<Env> {
  private drawingRoom?: DrawingRoom;
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
  }

  // WARNING: After deleteAll, the cached room still refers to rows whose tables were dropped.
  private open() {
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK (id = 1), link INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS rolls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, dice TEXT NOT NULL, seed INTEGER, expression TEXT)",
    );
    addRollColumns(sql);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS people (sub TEXT PRIMARY KEY, source TEXT, avatar TEXT, checked_at INTEGER NOT NULL)",
    );
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
    const room = new TLSocketRoom<TLRecord, Person>({
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

    // WARNING: Disconnection can miss a secret socket opened after its final session check unless both are serialized.
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!(await hasActiveSession(this.env.DB, pass.sessionHash))) {
        return new Response("Forbidden", { status: 403 });
      }
      return this.connectRoom(request, pass);
    });
  }

  disconnectSession(hash: string): void {
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
    if (refusal !== null) {
      log("board.refused", { board: pass.board, person: kind(pass.sub), reason: refusal });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.close(
        TLSyncErrorCloseEventCode,
        this.retired ? TLSyncErrorCloseEventReason.NOT_FOUND : SOCKET_REFUSAL[refusal],
      );
      return new Response(null, { status: 101, webSocket: client });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.room.handleSocketConnect({
      meta: {
        avatar,
        link: pass.link,
        name: pass.name,
        owner: pass.owner,
        sessionHash: pass.sessionHash,
        sub: pass.sub,
      },
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

  roll(pass: Pass, pool: number[], expression?: string, launch?: DiceLaunch): Refusal | Roll {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const at = Date.now();
    if (at - (this.lastRollAt.get(pass.sub) ?? 0) < MIN_ROLL_INTERVAL_MS) return "too-fast";
    this.lastRollAt.set(pass.sub, at);
    const dice = pool.map((sides) => ({ sides, value: rollDie(sides) }));
    const seed = drawSeed();
    const [row] = this.ctx.storage.sql
      .exec(
        "INSERT INTO rolls (at, sub, name, dice, seed, expression) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        at,
        pass.sub,
        pass.name,
        JSON.stringify(dice),
        seed,
        expression ?? null,
      )
      .toArray();
    const roll: Roll = {
      at,
      dice,
      ...(expression === undefined ? {} : { expression }),
      id: row!.id as number,
      ...(launch === undefined ? {} : { launch }),
      name: pass.name,
      seed,
      sub: pass.sub,
    };
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
      .exec("SELECT id, at, sub, name, dice, seed, expression FROM rolls ORDER BY id")
      .toArray()
      .map((row) => ({
        at: row.at as number,
        dice: JSON.parse(row.dice as string),
        ...(typeof row.expression === "string" ? { expression: row.expression } : {}),
        id: row.id as number,
        name: row.name as string,
        seed: row.seed as number | null,
        sub: row.sub as string,
      }));
  }

  private chatStorage(): SqlStorage {
    const { sql } = this.ctx.storage;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL)",
    );
    return sql;
  }

  chatHistory(pass: Pass): ChatMessage[] | Refusal {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    return this.chatStorage()
      .exec<ChatMessage>("SELECT id, at, sub, name, text FROM chat ORDER BY id")
      .toArray();
  }

  sendChat(pass: Pass, text: string): ChatMessage | Refusal {
    const refusal = this.admit(pass);
    if (refusal !== null) return refusal;
    const sql = this.chatStorage();
    const message = sql
      .exec<ChatMessage>(
        "INSERT INTO chat (at, sub, name, text) VALUES (?, ?, ?, ?) RETURNING id, at, sub, name, text",
        Date.now(),
        pass.sub,
        pass.name,
        text,
      )
      .one();
    sql.exec("DELETE FROM chat WHERE id <= ?", message.id - CHAT_HISTORY_LENGTH);
    for (const session of this.room.getSessions()) {
      this.room.sendCustomMessage(session.sessionId, { message, type: "chat" });
    }
    return message;
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
        // WARNING: Materialize these SQLite rows before updating the table they came from.
        const records = [...store.values()];
        for (const record of records) {
          if (isShape(record) && !isPublicSignature(record.id)) {
            store.set(record.id, stampPublicShape(record, now));
          }
        }
      });
      this.ctx.storage.kv.put(PUBLIC_EXPIRY_ENABLED, true);
      this.publicExpiryEnabled = true;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      const next = (Math.floor(Date.now() / PUBLIC_SWEEP_MS) + 1) * PUBLIC_SWEEP_MS;
      await this.ctx.storage.setAlarm(next);
    }
  }

  override async alarm(): Promise<void> {
    if (!this.publicExpiryEnabled) return;
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

  async destroy(board: string) {
    for (const session of this.room.getSessions()) {
      this.room.closeSession(session.sessionId, TLSyncErrorCloseEventReason.NOT_FOUND);
    }
    this.room.close();
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
