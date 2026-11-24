// A board's images: what kind of file the bytes are, the content address
// they are kept under, and the ledger in the board's Durable Object that
// counts what the board keeps, so the quota and the rate hold however many
// Workers take uploads at once.

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

// An ISO media file names its brands in its first box; AVIF is one whose
// major or compatible brands include avif (still) or avis (sequence).
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxEnd = Math.min(view.getUint32(0), bytes.length);
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(ascii(bytes, at, at + 4));
  return brands.includes("avif") || brands.includes("avis");
}

// An SVG is UTF-8 text whose root element is <svg>, after at most an XML
// declaration, comments and a doctype.
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

// The type the bytes are, whatever the upload said it was.
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

// A body, up to `max` bytes: a larger one is cut off as soon as it shows,
// whatever its Content-Length said. Uploads and the pictures
// src/avatars.ts copies are read through it.
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

// NOTE: every object of a board lives under its prefix, so deleting the
// board finds them all, even one the ledger lost track of.
export const boardPrefix = (board: string) => `boards/${board}/`;
export const fileKey = (board: string, hash: string) => `${boardPrefix(board)}${hash}`;
export const textKey = (board: string, hash: string, engine: string) =>
  `${fileKey(board, hash)}.ocr.${engine}.json`;

export type FileRefusal = "empty" | "over-quota" | "too-fast" | "too-large" | "unsupported";

export type StoredFile = { bytes: number; duplicate: boolean; hash: string; type: ImageType };

const MINUTE_MS = 60_000;

export class FileLedger {
  // Upload times per person in the last minute. Like the roll interval it
  // lives in memory: an evicted board forgets it, which only lets one more
  // minute's worth through.
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
    // The image's size, filled in the first time a text reading of it is
    // checked (src/text-store.ts).
    const columns = sql.exec("SELECT name FROM pragma_table_info('files')").toArray();
    if (!columns.some((column) => column.name === "width")) {
      sql.exec("ALTER TABLE files ADD COLUMN width INTEGER");
      sql.exec("ALTER TABLE files ADD COLUMN height INTEGER");
    }
    if (!columns.some((column) => column.name === "unused_at")) {
      sql.exec("ALTER TABLE files ADD COLUMN unused_at INTEGER");
    }
    // NOTE: sizes kept before a JPEG's EXIF orientation was applied are
    // read again: only a row marked upright holds the size as it shows.
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

  // What the board keeps in all: its images, and the text read off them
  // (src/text-store.ts keeps the texts table).
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
      // NOTE: the same image sent twice at once is written once; the second
      // answer waits for the first write.
      this.sql.exec("UPDATE files SET unused_at = NULL WHERE hash = ?", hash);
      await this.writing.get(hash);
      return { bytes, duplicate: true, hash, type };
    }
    if (this.storedBytes() + bytes > MAX_BOARD_FILE_BYTES) return "over-quota";
    // SAFETY: the row goes in before the write leaves, and with no await in
    // between, so a concurrent upload counts these bytes against the quota.
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

  // Only public rooms sweep unused uploads. A file must go unreferenced
  // for a whole sweep interval, so uploads and canvas writes can arrive apart.
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
    // If R2 fails, leave the ledger intact so the next alarm can retry.
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

  // Removes every object under the board's prefix; the ledger itself goes
  // with the board's storage.
  async wipe(board: string): Promise<number> {
    let removed = 0;
    let more = true;
    // Each round lists from the start again: what it deleted is gone.
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
