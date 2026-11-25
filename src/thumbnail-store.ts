import { PhotonImage } from "@cf-wasm/photon/workerd";

import {
  THUMBNAIL_DAILY_LIMIT,
  THUMBNAIL_DAY_MS,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_INTERVAL_MS,
  THUMBNAIL_WIDTH,
  type ThumbnailType,
} from "./board-thumbnail";
import { sniff } from "./file-store";
import { imageDimensions } from "./image-size";

export type ThumbnailWrite = "duplicate" | "forbidden" | "stored" | { retryAt: number };

export const thumbnailKey = (board: string) => `thumbnails/${board}`;

export function isThumbnail(body: ArrayBuffer, type: ThumbnailType): boolean {
  const bytes = new Uint8Array(body);
  if (sniff(bytes) !== type) return false;
  // The extended WebP header's animation bit is only set for animated files.
  if (
    type === "image/webp" &&
    String.fromCodePoint(...bytes.subarray(12, 16)) === "VP8X" &&
    ((bytes[20] ?? 0) & 2) !== 0
  ) {
    return false;
  }
  const dimensions = imageDimensions(bytes);
  if (
    dimensions === null ||
    dimensions.width > THUMBNAIL_WIDTH ||
    dimensions.height > THUMBNAIL_HEIGHT
  ) {
    return false;
  }
  try {
    // WARNING: A valid image header can still contain truncated or corrupt pixel data.
    const image = PhotonImage.new_from_byteslice(bytes);
    const matches =
      image.get_width() === dimensions.width && image.get_height() === dimensions.height;
    image.free();
    return matches;
  } catch {
    return false;
  }
}

/**
 * Writes under the board Durable Object's serialization and persists the
 * rate limit and content hash across hibernation.
 */
export async function writeThumbnail(
  sql: SqlStorage,
  bucket: R2Bucket,
  board: string,
  body: ArrayBuffer,
  type: ThumbnailType,
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
  await bucket.put(thumbnailKey(board), body, { httpMetadata: { contentType: type } });
  sql.exec(
    `INSERT INTO thumbnail (id, updated_at, writes_today, hash) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET updated_at = ?1, writes_today = ?2, hash = ?3`,
    now,
    count + 1,
    hash,
  );
  return "stored";
}
