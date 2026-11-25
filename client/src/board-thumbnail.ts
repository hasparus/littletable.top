import { Box, type Editor } from "tldraw";

import type { Bootstrap } from "./bootstrap";

import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_INTERVAL_MS,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TYPE,
  THUMBNAIL_WIDTH,
  thumbnailUrl,
} from "../../src/board-thumbnail";

const SETTLE_MS = 3000;
const FIRST_RETRY_MS = 5000;

async function renderThumbnail(editor: Editor): Promise<Blob | null> {
  const content = editor.getCurrentPageBounds();
  if (content === undefined) {
    // A board whose last shape was deleted now shows an empty whiteboard.
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, THUMBNAIL_TYPE));
  }
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  // Leave a small margin around the drawing and pad to the list's aspect.
  const height = Math.max(1, content.h, content.w / aspect) * 1.1;
  const width = height * aspect;
  const bounds = new Box(content.midX - width / 2, content.midY - height / 2, width, height);
  const { blob } = await editor.toImage([], {
    background: true,
    bounds,
    darkMode: false,
    format: "webp",
    padding: 0,
    pixelRatio: 1,
    quality: 0.65,
    scale: THUMBNAIL_WIDTH / width,
  });
  return blob;
}

export function keepThumbnail(
  editor: Editor,
  board: string,
  grant: NonNullable<Bootstrap["thumbnail"]>,
) {
  let available = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | null = null;
  let dirty = grant.needed && editor.getCurrentPageShapeIds().size > 0;
  let nextCapture = 0;
  let retryDelay = FIRST_RETRY_MS;

  // Wait for edits to settle. Camera changes and presence are session records.
  const schedule = () => {
    clearTimeout(timer);
    if (!available || disposed || !dirty || pending !== null) return;
    timer = setTimeout(() => void capture(), Math.max(SETTLE_MS, nextCapture - Date.now()));
  };

  function retry(retryAfter?: string | null) {
    const seconds = Number(retryAfter);
    dirty = true;
    nextCapture =
      Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : retryDelay);
    retryDelay = Math.min(2 * retryDelay, THUMBNAIL_INTERVAL_MS);
  }

  async function capture() {
    const attempt = new AbortController();
    pending = attempt;
    dirty = false;
    try {
      const image = await renderThumbnail(editor);
      if (
        attempt.signal.aborted ||
        image === null ||
        image.type !== THUMBNAIL_TYPE ||
        image.size > THUMBNAIL_MAX_BYTES
      )
        return;
      const response = await fetch(thumbnailUrl(board), {
        body: image,
        headers: {
          "Content-Type": THUMBNAIL_TYPE,
          "X-Board-Link": String(grant.link),
          "X-CSRF-Token": grant.csrf,
        },
        method: "PUT",
        signal: attempt.signal,
      }).catch(() => null);
      if (response?.ok === true) {
        nextCapture = Date.now() + THUMBNAIL_INTERVAL_MS;
        retryDelay = FIRST_RETRY_MS;
      } else if (!attempt.signal.aborted) {
        if (response === null || response.status >= 500) retry();
        else if (response.status === 429) retry(response.headers.get("Retry-After"));
        else retryDelay = FIRST_RETRY_MS;
      }
    } catch {
      // An optional preview must not interrupt the editor or its sync.
    } finally {
      pending = null;
      schedule();
    }
  }

  const unlisten = editor.store.listen(
    () => {
      dirty = true;
      schedule();
    },
    { scope: "document", source: "all" },
  );
  return {
    dispose() {
      disposed = true;
      unlisten();
      pending?.abort();
      clearTimeout(timer);
    },
    setAvailable(value: boolean) {
      if (available === value) return;
      available = value;
      if (!available && pending !== null) {
        dirty = true;
        pending.abort();
      }
      schedule();
    },
  };
}
