// The same limits apply to the browser export and the storage endpoint.
export const THUMBNAIL_TYPE = "image/webp";
export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 180;
export const THUMBNAIL_MAX_BYTES = 50_000;
export const THUMBNAIL_INTERVAL_MS = 5 * 60_000;
export const THUMBNAIL_DAILY_LIMIT = 8;
export const THUMBNAIL_DAY_MS = 24 * 60 * 60_000;

export const thumbnailUrl = (id: string) => `/api/boards/${id}/thumbnail`;
