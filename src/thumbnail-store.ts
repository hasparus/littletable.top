import {
  THUMBNAIL_DAILY_LIMIT,
  THUMBNAIL_DAY_MS,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_INTERVAL_MS,
  THUMBNAIL_TYPE,
  THUMBNAIL_WIDTH,
} from "./board-thumbnail";
import { sniff } from "./file-store";
import { imageDimensions } from "./image-size";

export type ThumbnailWrite = "duplicate" | "forbidden" | "stored" | { retryAt: number };

export const thumbnailKey = (board: string) => `thumbnails/${board}.webp`;

export function isThumbnail(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body);
  if (sniff(bytes) !== THUMBNAIL_TYPE) return false;
  // A static raster only. Animated extended WebP sets bit 1 in VP8X flags.
  if (
    bytes[12] === 86 &&
    bytes[13] === 80 &&
    bytes[14] === 56 &&
    bytes[15] === 88 &&
    ((bytes[20] ?? 0) & 2) !== 0
  )
    return false;
  const dimensions = imageDimensions(bytes);
  return (
    dimensions !== null &&
    dimensions.width <= THUMBNAIL_WIDTH &&
    dimensions.height <= THUMBNAIL_HEIGHT
  );
}

// Serialized by the board's Durable Object. Keep the rate limit across
// hibernation and the latest content hash to avoid rewriting identical art.
export async function writeThumbnail(
  sql: SqlStorage,
  bucket: R2Bucket,
  board: string,
  body: ArrayBuffer,
  now: number,
): Promise<ThumbnailWrite> {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS thumbnail (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL, writes_today INTEGER NOT NULL, hash TEXT NOT NULL)",
  );
  const [latest] = sql
    .exec<{ hash: string; updated_at: number; writes_today: number }>(
      "SELECT updated_at, writes_today, hash FROM thumbnail WHERE id = 1",
    )
    .toArray();
  const day = Math.floor(now / THUMBNAIL_DAY_MS);
  const today = latest !== undefined && Math.floor(latest.updated_at / THUMBNAIL_DAY_MS) === day;
  const count = today ? latest.writes_today : 0;
  if (latest !== undefined && now < latest.updated_at + THUMBNAIL_INTERVAL_MS) {
    return { retryAt: latest.updated_at + THUMBNAIL_INTERVAL_MS };
  }
  if (count >= THUMBNAIL_DAILY_LIMIT) return { retryAt: (day + 1) * THUMBNAIL_DAY_MS };

  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (latest?.hash === hash) return "duplicate";
  await bucket.put(thumbnailKey(board), body, { httpMetadata: { contentType: THUMBNAIL_TYPE } });
  sql.exec(
    `INSERT INTO thumbnail (id, updated_at, writes_today, hash) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET updated_at = ?1, writes_today = ?2, hash = ?3`,
    now,
    count + 1,
    hash,
  );
  return "stored";
}
