// The same limits apply to the browser export and the storage endpoint.
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 180;
export const THUMBNAIL_MAX_BYTES = 50_000;
export const THUMBNAIL_INTERVAL_MS = 5 * 60_000;
export const THUMBNAIL_DAILY_LIMIT = 8;
export const THUMBNAIL_DAY_MS = 24 * 60 * 60_000;

export type ThumbnailType = "image/png" | "image/webp";

export function isThumbnailType(type: string | null): type is ThumbnailType {
  return type === "image/webp" || type === "image/png";
}

// Allow the full RGBA canvas plus PNG filtering and container overhead.
export const thumbnailByteLimit = (type: ThumbnailType) =>
  type === "image/png" ? 240_000 : THUMBNAIL_MAX_BYTES;

export const thumbnailUrl = (id: string) => `/api/boards/${id}/thumbnail`;
