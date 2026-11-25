import { Box, type Editor, type TLShapeId } from "tldraw";

import type { Bootstrap } from "./bootstrap";

import {
  isThumbnailType,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_INTERVAL_MS,
  THUMBNAIL_WIDTH,
  thumbnailByteLimit,
  thumbnailUrl,
} from "../../src/board-thumbnail";

const SETTLE_MS = 3000;
const FIRST_RETRY_MS = 5000;

function thumbnailPage(editor: Editor) {
  // Use the first populated shared page so every editor captures the same content.
  for (const page of editor.getPages()) {
    const shapes = editor.getPageShapeIds(page);
    if (shapes.size > 0) return { id: page.id, shapes };
  }
  return null;
}

async function renderThumbnail(editor: Editor, shapes: Set<TLShapeId>): Promise<Blob | null> {
  const boxes = [...shapes].flatMap((id) => {
    if (editor.isShapeHidden(id)) return [];
    const bounds = editor.getShapeMaskedPageBounds(id);
    return bounds === undefined ? [] : [bounds];
  });
  if (boxes.length === 0) {
    // Store a transparent canvas after the last drawing was erased.
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.65));
  }
  const content = Box.Common(boxes);
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  const height = Math.max(1, content.h, content.w / aspect) * 1.1;
  const width = height * aspect;
  const bounds = new Box(content.midX - width / 2, content.midY - height / 2, width, height);
  const { blob } = await editor.toImage([...shapes], {
    background: false,
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
  let page = thumbnailPage(editor);
  let dirty = grant.needed && page !== null;
  let nextCapture = 0;
  let retryDelay = FIRST_RETRY_MS;

  // WARNING: Camera changes and presence are session records. They must not trigger a thumbnail write.
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
    const target = page;
    pending = attempt;
    dirty = false;
    try {
      const image = await renderThumbnail(editor, target?.shapes ?? new Set());
      if (
        attempt.signal.aborted ||
        target?.id !== page?.id ||
        image === null ||
        !isThumbnailType(image.type) ||
        image.size > thumbnailByteLimit(image.type)
      )
        return;
      const response = await fetch(thumbnailUrl(board), {
        body: image,
        headers: {
          "Content-Type": image.type,
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
    ({ changes }) => {
      const previous = page;
      page = thumbnailPage(editor);
      if (previous?.id === page?.id) {
        if (page === null) return;
        const { shapes } = page;
        const records = [
          ...Object.values(changes.added),
          ...Object.values(changes.updated).map(([, after]) => after),
          ...Object.values(changes.removed),
        ];
        const affectsPage = records.some((record) => {
          if (record.typeName === "shape") {
            return shapes.has(record.id) || previous?.shapes.has(record.id) === true;
          }
          if (record.typeName === "binding") {
            return shapes.has(record.fromId) || shapes.has(record.toId);
          }
          return record.typeName === "asset";
        });
        if (!affectsPage) return;
      }
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
