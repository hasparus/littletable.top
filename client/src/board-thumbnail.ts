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
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let dirty = grant.needed && editor.getCurrentPageShapeIds().size > 0;
  let nextCapture = 0;

  // Wait for edits to settle. Edits during an upload get another turn after
  // the board-wide throttle. Camera changes and presence are session records.
  const schedule = () => {
    clearTimeout(timer);
    if (!dirty || writing || controller.signal.aborted) return;
    timer = setTimeout(() => void capture(), Math.max(SETTLE_MS, nextCapture - Date.now()));
  };

  async function capture() {
    writing = true;
    dirty = false;
    nextCapture = Date.now() + THUMBNAIL_INTERVAL_MS;
    try {
      const image = await renderThumbnail(editor);
      if (
        controller.signal.aborted ||
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
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retryIn = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(retryIn) && retryIn > 0) {
          dirty = true;
          nextCapture = Date.now() + retryIn * 1000;
        }
      }
    } catch {
      // An optional preview must not interrupt the editor or its sync.
    } finally {
      writing = false;
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
  schedule();
  return () => {
    unlisten();
    controller.abort();
    clearTimeout(timer);
  };
}
