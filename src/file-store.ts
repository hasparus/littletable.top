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

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// NOTE: every object of a board lives under its prefix, so deleting the
// board finds them all, even one the ledger lost track of.
export const boardPrefix = (board: string) => `boards/${board}/`;
export const fileKey = (board: string, hash: string) => `${boardPrefix(board)}${hash}`;

export type FileRefusal = "empty" | "over-quota" | "too-fast" | "too-large" | "unsupported";

export type StoredFile = { bytes: number; duplicate: boolean; hash: string; type: ImageType };

const MINUTE_MS = 60_000;

export class FileLedger {
  // Upload times per person in the last minute. Like the roll interval it
  // lives in memory: an evicted board forgets it, which only lets one more
  // minute's worth through.
  private readonly recent = new Map<string, number[]>();
  private readonly writing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS files (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }

  private spend(sub: string, at: number): boolean {
    const recent = (this.recent.get(sub) ?? []).filter((time) => at - time < MINUTE_MS);
    if (recent.length >= MAX_UPLOADS_PER_MINUTE) return false;
    recent.push(at);
    this.recent.set(sub, recent);
    return true;
  }

  private storedBytes(): number {
    const [row] = this.sql.exec("SELECT COALESCE(SUM(bytes), 0) AS total FROM files").toArray();
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
    const known = this.sql.exec("SELECT 1 FROM files WHERE hash = ?", hash).toArray();
    if (known.length > 0) {
      // NOTE: the same image sent twice at once is written once; the second
      // answer waits for the first write.
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
