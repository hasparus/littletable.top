import { MAX_BOARD_FILE_BYTES, MAX_FILE_BYTES, MAX_UPLOADS_PER_MINUTE } from "./limits";

export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCodePoint(...bytes.subarray(from, to));

const startsWith = (bytes: Uint8Array, prefix: string) =>
  bytes.length >= prefix.length && ascii(bytes, 0, prefix.length) === prefix;

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxEnd = Math.min(view.getUint32(0), bytes.length);
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(ascii(bytes, at, at + 4));
  return brands.includes("avif") || brands.includes("avis");
}

const SVG_ROOT =
  /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/iu;

function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return SVG_ROOT.test(text);
}

export function sniff(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, "\u0089PNG\r\n\u001A\n")) return "image/png";
  if (startsWith(bytes, "\u00FF\u00D8\u00FF")) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && bytes.length >= 12 && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (isAvif(bytes)) return "image/avif";
  if (isSvg(bytes)) return "image/svg+xml";
  return null;
}

/** Caps streamed bytes independently of the declared Content-Length. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  { declared, max }: { declared: number; max: number },
): Promise<"too-large" | ArrayBuffer> {
  if (declared > max) return "too-large";
  if (body === null) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole.buffer;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// WARNING: Keep board objects under this prefix so deletion also finds files missing from the ledger.
export const boardPrefix = (board: string) => `boards/${board}/`;
export const fileKey = (board: string, hash: string) => `${boardPrefix(board)}${hash}`;
export const textKey = (board: string, hash: string, engine: string) =>
  `${fileKey(board, hash)}.ocr.${engine}.json`;

export type FileRefusal = "empty" | "over-quota" | "too-fast" | "too-large" | "unsupported";

export type StoredFile = { bytes: number; duplicate: boolean; hash: string; type: ImageType };

const MINUTE_MS = 60_000;

export class FileLedger {
  // WARNING: An evicted room forgets the upload rate window, allowing at most one extra window of uploads.
  private readonly recent = new Map<string, number[]>();
  private readonly writing = new Map<string, Promise<unknown>>();
  private readonly removing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS files (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    const columns = sql.exec("SELECT name FROM pragma_table_info('files')").toArray();
    if (!columns.some((column) => column.name === "width")) {
      sql.exec("ALTER TABLE files ADD COLUMN width INTEGER");
      sql.exec("ALTER TABLE files ADD COLUMN height INTEGER");
    }
    if (!columns.some((column) => column.name === "unused_at")) {
      sql.exec("ALTER TABLE files ADD COLUMN unused_at INTEGER");
    }
    // WARNING: Remeasure older JPEGs unless the cached size already accounts for EXIF orientation.
    if (!columns.some((column) => column.name === "upright")) {
      sql.exec("ALTER TABLE files ADD COLUMN upright INTEGER");
    }
  }

  private spend(sub: string, at: number): boolean {
    const recent = (this.recent.get(sub) ?? []).filter((time) => at - time < MINUTE_MS);
    if (recent.length >= MAX_UPLOADS_PER_MINUTE) return false;
    recent.push(at);
    this.recent.set(sub, recent);
    return true;
  }

  storedBytes(): number {
    const [row] = this.sql
      .exec(
        "SELECT (SELECT COALESCE(SUM(bytes), 0) FROM files) + (SELECT COALESCE(SUM(bytes), 0) FROM texts) AS total",
      )
      .toArray();
    return row!.total as number;
  }

  async store(board: string, sub: string, body: ArrayBuffer): Promise<FileRefusal | StoredFile> {
    const at = Date.now();
    if (!this.spend(sub, at)) return "too-fast";
    if (body.byteLength === 0) return "empty";
    if (body.byteLength > MAX_FILE_BYTES) return "too-large";
    const type = sniff(new Uint8Array(body));
    if (type === null) return "unsupported";
    const hash = await sha256Hex(body);
    const bytes = body.byteLength;
    await this.removing.get(hash);
    const known = this.sql.exec("SELECT 1 FROM files WHERE hash = ?", hash).toArray();
    if (known.length > 0) {
      // WARNING: The ledger row can exist before the first upload reaches R2.
      this.sql.exec("UPDATE files SET unused_at = NULL WHERE hash = ?", hash);
      await this.writing.get(hash);
      return { bytes, duplicate: true, hash, type };
    }
    if (this.storedBytes() + bytes > MAX_BOARD_FILE_BYTES) return "over-quota";
    // WARNING: Awaiting before reservation would let concurrent uploads bypass the board quota.
    this.sql.exec(
      "INSERT INTO files (hash, bytes, type, at) VALUES (?, ?, ?, ?)",
      hash,
      bytes,
      type,
      at,
    );
    const write = this.bucket.put(fileKey(board, hash), body, {
      httpMetadata: { contentType: type },
      sha256: hash,
    });
    this.writing.set(hash, write);
    try {
      await write;
    } catch (error) {
      this.sql.exec("DELETE FROM files WHERE hash = ?", hash);
      throw error;
    } finally {
      this.writing.delete(hash);
    }
    return { bytes, duplicate: false, hash, type };
  }

  // WARNING: Sweep only public boards after a grace interval because uploads and canvas updates can arrive separately.
  async reclaimUnused(
    board: string,
    live: ReadonlySet<string>,
    now: number,
    grace: number,
    textBusy: (hash: string) => boolean,
  ): Promise<string[]> {
    const candidates: string[] = [];
    for (const { hash, unused_at: unusedAt } of this.sql
      .exec<{ hash: string; unused_at: number | null }>("SELECT hash, unused_at FROM files")
      .toArray()) {
      if (live.has(hash) || this.writing.has(hash) || textBusy(hash)) {
        if (unusedAt !== null)
          this.sql.exec("UPDATE files SET unused_at = NULL WHERE hash = ?", hash);
      } else if (unusedAt === null) {
        this.sql.exec("UPDATE files SET unused_at = ? WHERE hash = ?", now, hash);
      } else if (now - unusedAt >= grace && candidates.length < 64) {
        candidates.push(hash);
      }
    }
    if (candidates.length === 0) return candidates;
    const keys = candidates.flatMap((hash) => [
      fileKey(board, hash),
      ...this.sql
        .exec<{ engine: string }>("SELECT engine FROM texts WHERE hash = ?", hash)
        .toArray()
        .map(({ engine }) => textKey(board, hash, engine)),
    ]);
    // WARNING: Keep ledger entries until R2 deletion succeeds so the next alarm can retry.
    const remove = this.bucket.delete(keys);
    for (const hash of candidates) this.removing.set(hash, remove);
    try {
      await remove;
      for (const hash of candidates) {
        this.sql.exec("DELETE FROM texts WHERE hash = ?", hash);
        this.sql.exec("DELETE FROM text_failures WHERE hash = ?", hash);
        this.sql.exec("DELETE FROM files WHERE hash = ?", hash);
      }
      return candidates;
    } finally {
      for (const hash of candidates) this.removing.delete(hash);
    }
  }

  /** Deletes the board’s stored objects. The caller discards the ledger with the room storage. */
  async wipe(board: string): Promise<number> {
    let removed = 0;
    let more = true;
    while (more) {
      const page = await this.bucket.list({ prefix: boardPrefix(board) });
      const keys = page.objects.map((object) => object.key);
      if (keys.length > 0) await this.bucket.delete(keys);
      removed += keys.length;
      more = page.truncated && keys.length > 0;
    }
    return removed;
  }
}
