import { fileKey, textKey } from "./file-store";
import { imageDimensions, type Shown, SIZE_PREFIX_BYTES } from "./image-size";
import {
  MAX_BOARD_FILE_BYTES,
  MAX_TEXT_CLAIMS_PER_MINUTE,
  MAX_TEXT_FAILURES,
  MAX_TEXT_WRITES_PER_MINUTE,
  TEXT_LEASE_MS,
} from "./limits";
import { spendRoomAllowance } from "./room-allowance";
import {
  type EngineKey,
  isEngineKey,
  TEXT_ENGINES,
  type TextResult,
  validateTextResult,
} from "./text-result";

export type Reading = { engine: EngineKey; hash: string };

export type TextListing = {
  /** Images and engines that have reached MAX_TEXT_FAILURES. */
  failed: Reading[];
  reading: Reading[];
  stored: Reading[];
};

export type Claim = { engines: EngineKey[]; hash: string; lease: string; until: number };

export type ClaimRequest = { candidates: string[]; engines: EngineKey[]; prefer: string | null };

export type TextRefusal = "invalid" | "over-quota" | "too-fast" | "unknown-image" | "unreadable";

export type StoredText = { body: string; duplicate: boolean; words: number };

type ReconciledText = false | true | StoredText;

const HASH = /^[0-9a-f]{64}$/u;
const MAX_CANDIDATES = 2000;

const pairOf = (hash: string, engine: string) => `${hash} ${engine}`;

export function parseClaim(body: unknown): ClaimRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { candidates, engines, prefer = null } = body as Record<string, unknown>;
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) return null;
  if (!Array.isArray(engines) || engines.length === 0 || engines.length > 8) return null;
  if (!candidates.every((hash) => typeof hash === "string" && HASH.test(hash))) return null;
  if (!engines.every((engine) => typeof engine === "string" && isEngineKey(engine))) return null;
  if (prefer !== null && (typeof prefer !== "string" || !HASH.test(prefer))) return null;
  return { candidates, engines: [...new Set(engines)], prefer };
}

export class TextLedger {
  private readonly writing = new Map<string, Promise<ReconciledText>>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS texts (hash TEXT NOT NULL, engine TEXT NOT NULL, bytes INTEGER NOT NULL, words INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (hash, engine))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS text_failures (hash TEXT NOT NULL, engine TEXT NOT NULL, failures INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (hash, engine))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS text_leases (hash TEXT NOT NULL, engine TEXT NOT NULL, lease TEXT NOT NULL, sub TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (hash, engine))",
    );
    const columns = sql.exec("SELECT name FROM pragma_table_info('texts')").toArray();
    if (!columns.some((column) => column.name === "pending_body")) {
      sql.exec("ALTER TABLE texts ADD COLUMN pending_body TEXT");
    }
    if (!columns.some((column) => column.name === "ready")) {
      sql.exec("ALTER TABLE texts ADD COLUMN ready INTEGER NOT NULL DEFAULT 0");
    }
  }

  private readings(query: string, ...bindings: (string | number)[]): Reading[] {
    return this.sql
      .exec(query, ...bindings)
      .toArray()
      .map((row) => ({ engine: row.engine as EngineKey, hash: row.hash as string }));
  }

  async listing(board: string, at = Date.now()): Promise<TextListing> {
    for (;;) {
      const batch = this.readings("SELECT hash, engine FROM texts WHERE ready = 0 LIMIT 32");
      if (batch.length === 0) break;
      await Promise.all(batch.map(({ engine, hash }) => this.reconcile(board, hash, engine)));
    }
    return {
      failed: this.readings(
        "SELECT hash, engine FROM text_failures WHERE failures >= ?",
        MAX_TEXT_FAILURES,
      ),
      reading: this.readings("SELECT hash, engine FROM text_leases WHERE until > ?", at),
      stored: this.readings("SELECT hash, engine FROM texts WHERE ready = 1"),
    };
  }

  private has(hash: string, engine: EngineKey): boolean {
    return (
      this.sql.exec("SELECT 1 FROM texts WHERE hash = ? AND engine = ?", hash, engine).toArray()
        .length > 0
    );
  }

  private needsReading(hash: string, engine: EngineKey) {
    const blocked = this.sql.exec(
      "SELECT 1 FROM text_leases WHERE hash = ?1 AND engine = ?2 UNION ALL SELECT 1 FROM texts WHERE hash = ?1 AND engine = ?2 UNION ALL SELECT 1 FROM text_failures WHERE hash = ?1 AND engine = ?2 AND failures >= ?3 LIMIT 1",
      hash,
      engine,
      MAX_TEXT_FAILURES,
    );
    return blocked.toArray().length === 0;
  }

  private readable(hash: string): boolean {
    const [row] = this.sql.exec("SELECT type FROM files WHERE hash = ?", hash).toArray();
    return row !== undefined && row.type !== "image/svg+xml";
  }

  claim(sub: string, request: ClaimRequest, at = Date.now()): "too-fast" | Claim | null {
    if (!spendRoomAllowance(this.sql, "text-claim", sub, at, MAX_TEXT_CLAIMS_PER_MINUTE)) {
      return "too-fast";
    }
    this.sql.exec("DELETE FROM text_leases WHERE until <= ?", at);
    const order =
      request.prefer === null ? request.candidates : [request.prefer, ...request.candidates];
    for (const hash of new Set(order)) {
      if (!this.readable(hash)) continue;
      const engines = request.engines.filter((engine) => this.needsReading(hash, engine));
      if (engines.length === 0) continue;
      const lease = crypto.randomUUID();
      const until = at + TEXT_LEASE_MS;
      for (const engine of engines) {
        this.sql.exec(
          "INSERT INTO text_leases (hash, engine, lease, sub, until) VALUES (?, ?, ?, ?, ?)",
          hash,
          engine,
          lease,
          sub,
          until,
        );
      }
      return { engines, hash, lease, until };
    }
    return null;
  }

  renew(sub: string, lease: string, at = Date.now()): boolean {
    return (
      this.sql.exec(
        "UPDATE text_leases SET until = ? WHERE lease = ? AND sub = ? AND until > ?",
        at + TEXT_LEASE_MS,
        lease,
        sub,
        at,
      ).rowsWritten > 0
    );
  }

  release(sub: string, lease: string, failed: readonly EngineKey[], at = Date.now()): Reading[] {
    const held = this.readings(
      "DELETE FROM text_leases WHERE lease = ? AND sub = ? AND until > ? RETURNING hash, engine",
      lease,
      sub,
      at,
    );
    for (const pair of held) {
      if (!failed.includes(pair.engine)) continue;
      this.sql.exec(
        "INSERT INTO text_failures (hash, engine, failures, at) VALUES (?, ?, 1, ?) ON CONFLICT (hash, engine) DO UPDATE SET failures = failures + 1, at = excluded.at",
        pair.hash,
        pair.engine,
        at,
      );
    }
    return held;
  }

  private async dimensions(board: string, hash: string): Promise<Shown | null> {
    const [row] = this.sql
      .exec("SELECT width, height, type, upright FROM files WHERE hash = ?", hash)
      .toArray();
    if (row?.upright === 1 && row.width !== null) {
      const exact = row.type === "image/jpeg" || row.type === "image/gif";
      return { exact, height: row.height as number, width: row.width as number };
    }
    const object = await this.bucket.get(fileKey(board, hash), {
      range: { length: SIZE_PREFIX_BYTES, offset: 0 },
    });
    if (object === null) return null;
    const size = imageDimensions(new Uint8Array(await object.arrayBuffer()));
    if (size !== null) {
      this.sql.exec(
        "UPDATE files SET width = ?, height = ?, upright = 1 WHERE hash = ?",
        size.width,
        size.height,
        hash,
      );
    }
    return size;
  }

  busy(hash: string): boolean {
    return Object.keys(TEXT_ENGINES).some((engine) => this.writing.has(pairOf(hash, engine)));
  }

  private async reconcile(board: string, hash: string, engine: EngineKey): Promise<ReconciledText> {
    const pair = pairOf(hash, engine);
    const active = this.writing.get(pair);
    if (active !== undefined) return active;
    const [row] = this.sql
      .exec<{ pending_body: string | null; ready: number }>(
        "SELECT pending_body, ready FROM texts WHERE hash = ? AND engine = ?",
        hash,
        engine,
      )
      .toArray();
    if (row === undefined) return false;
    if (row.ready === 1) return true;
    const check = this.finish(board, hash, engine, row.pending_body);
    this.writing.set(pair, check);
    try {
      return await check;
    } finally {
      this.writing.delete(pair);
    }
  }

  private async finish(
    board: string,
    hash: string,
    engine: EngineKey,
    pending: string | null,
  ): Promise<ReconciledText> {
    const key = textKey(board, hash, engine);
    let existing: StoredText | undefined;
    if (pending !== null) {
      // WARNING: A restart can leave the first result in R2 before SQLite recorded completion.
      const written = await this.bucket.put(key, pending, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (written === null) {
        const object = await this.bucket.get(key);
        if (object === null) throw new Error("Stored text disappeared during recovery");
        const body = await object.text();
        if (body !== pending) {
          const result = JSON.parse(body) as TextResult;
          const words = result.lines.reduce((sum, line) => sum + line.words.length, 0);
          this.sql.exec(
            "UPDATE texts SET bytes = ?, words = ? WHERE hash = ? AND engine = ?",
            object.size,
            words,
            hash,
            engine,
          );
          existing = { body, duplicate: true, words };
        }
      }
    } else if ((await this.bucket.head(key)) === null) {
      this.sql.exec("DELETE FROM texts WHERE hash = ? AND engine = ?", hash, engine);
      this.sql.exec("DELETE FROM text_leases WHERE hash = ? AND engine = ?", hash, engine);
      this.sql.exec("DELETE FROM text_failures WHERE hash = ? AND engine = ?", hash, engine);
      return false;
    }
    this.sql.exec(
      "UPDATE texts SET ready = 1, pending_body = NULL WHERE hash = ? AND engine = ?",
      hash,
      engine,
    );
    this.sql.exec("DELETE FROM text_leases WHERE hash = ? AND engine = ?", hash, engine);
    return existing ?? true;
  }

  private async stored(board: string, hash: string, engine: EngineKey): Promise<StoredText | null> {
    const reconciled = await this.reconcile(board, hash, engine);
    if (reconciled === false) return null;
    if (reconciled !== true) return reconciled;
    const object = await this.bucket.get(textKey(board, hash, engine));
    const [row] = this.sql
      .exec("SELECT words FROM texts WHERE hash = ? AND engine = ?", hash, engine)
      .toArray();
    if (object === null || row === undefined) throw new Error("Stored text is missing");
    return { body: await object.text(), duplicate: true, words: row.words as number };
  }

  /** Stores the first valid result per image and engine, returning that result to later writers. */
  async store(
    { board, engine, hash, sub }: { board: string; engine: EngineKey; hash: string; sub: string },
    raw: ArrayBuffer,
    { at = Date.now(), bytesNow }: { at?: number; bytesNow: () => number },
  ): Promise<
    Exclude<TextRefusal, "invalid"> | StoredText | { problem: string; refusal: "invalid" }
  > {
    if (!spendRoomAllowance(this.sql, "text-write", sub, at, MAX_TEXT_WRITES_PER_MINUTE)) {
      return "too-fast";
    }
    if (this.sql.exec("SELECT 1 FROM files WHERE hash = ?", hash).toArray().length === 0) {
      return "unknown-image";
    }
    while (this.has(hash, engine)) {
      const stored = await this.stored(board, hash, engine);
      if (stored !== null) return stored;
    }
    const size = this.readable(hash) ? await this.dimensions(board, hash) : null;
    if (size === null) return "unreadable";
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return { problem: "not JSON", refusal: "invalid" };
    }
    const checked = validateTextResult(parsed, {
      createdAt: new Date(at).toISOString(),
      engine,
      sha256: hash,
      ...size,
    });
    if ("problem" in checked) return { problem: checked.problem, refusal: "invalid" };
    // WARNING: Another write of this image and engine can finish while the dimensions check awaits R2.
    while (this.has(hash, engine)) {
      const stored = await this.stored(board, hash, engine);
      if (stored !== null) return stored;
    }
    const body = JSON.stringify(checked.result);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytesNow() + bytes > MAX_BOARD_FILE_BYTES) return "over-quota";
    const words = checked.result.lines.reduce((sum, line) => sum + line.words.length, 0);
    // WARNING: Reserve the row before awaiting R2 so concurrent writes respect the quota and first-write wins.
    this.sql.exec(
      "INSERT INTO texts (hash, engine, bytes, words, at, pending_body) VALUES (?, ?, ?, ?, ?, ?)",
      hash,
      engine,
      bytes,
      words,
      at,
      body,
    );
    const reconciled = await this.reconcile(board, hash, engine);
    if (reconciled === false) throw new Error("Text reservation is missing");
    return reconciled === true ? { body, duplicate: false, words } : reconciled;
  }
}
