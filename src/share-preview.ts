import { PhotonImage, resize, SamplingFilter, watermark } from "@cf-wasm/photon/workerd";

import type { BoardRoom } from "./board-room";
import type { Board } from "./standalone/store";

import { PALETTE } from "./board-palette";
import { SHARE_ART, SHARE_ART_BACKGROUND, SHARE_ART_WINDOW } from "./share-art";
import { thumbnailKey } from "./thumbnail-store";

function solidBackground(width: number, height: number, background: string): PhotonImage {
  const color = Number.parseInt(background.slice(1), 16);
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = color >> 16;
    pixels[i + 1] = color >> 8;
    pixels[i + 2] = color;
    pixels[i + 3] = 255;
  }
  return new PhotonImage(pixels, width, height);
}

function renderPreview(
  templateBytes: ArrayBuffer,
  thumbnailBytes: ArrayBuffer,
  background: string,
): Uint8Array {
  const images: PhotonImage[] = [];
  try {
    const template = PhotonImage.new_from_byteslice(new Uint8Array(templateBytes));
    images.push(template);
    const card = solidBackground(template.get_width(), template.get_height(), background);
    images.push(card);
    watermark(card, template, 0n, 0n);
    const drawing = PhotonImage.new_from_byteslice(new Uint8Array(thumbnailBytes));
    images.push(drawing);

    const { height, left, top, width } = SHARE_ART_WINDOW;
    const scale = Math.min(width / drawing.get_width(), height / drawing.get_height());
    const drawnWidth = Math.max(1, Math.round(drawing.get_width() * scale));
    const drawnHeight = Math.max(1, Math.round(drawing.get_height() * scale));
    const resized = resize(drawing, drawnWidth, drawnHeight, SamplingFilter.Triangle);
    images.push(resized);
    watermark(
      card,
      resized,
      BigInt(left + Math.floor((width - drawnWidth) / 2)),
      BigInt(top + Math.floor((height - drawnHeight) / 2)),
    );
    return card.get_bytes();
  } finally {
    for (const image of images) image.free();
  }
}

export type PreviewBindings = {
  ASSETS: Fetcher;
  BoardRoom: DurableObjectNamespace<BoardRoom>;
  Files: R2Bucket;
};

export async function composeBoardPreview(
  url: URL,
  board: Board,
  { ASSETS, BoardRoom, Files }: PreviewBindings,
): Promise<Response | null> {
  try {
    const room = BoardRoom.get(BoardRoom.idFromName(board.id));
    const [template, thumbnail, color] = await Promise.all([
      ASSETS.fetch(new URL(SHARE_ART, url)),
      Files.get(thumbnailKey(board.id)),
      room.backgroundForSharePreview(board.linkVersion).catch(() => "default" as const),
    ]);
    if (!template.ok || template.body === null || thumbnail === null || color === null) return null;
    const background = color === "default" ? SHARE_ART_BACKGROUND : PALETTE[color].light;

    // Only the valid-link route can reach this cache. Color can change while
    // the drawing bytes remain identical, so each is part of the key.
    const artTag = template.headers.get("ETag");
    let cacheKey: string | null = null;
    let cache: Cache | null = null;
    if (artTag !== null) {
      const key = new URL(`/__share-preview/${board.id}`, url);
      key.searchParams.set("drawing", thumbnail.etag);
      key.searchParams.set("art", artTag);
      key.searchParams.set("background", background);
      cacheKey = key.href;
      cache = await caches.open("board-share-previews").catch(() => null);
      const cached = (await cache?.match(cacheKey).catch(() => null)) ?? null;
      if (cached !== null) {
        await Promise.allSettled([template.body.cancel(), thumbnail.body.cancel()]);
        return cached;
      }
    }

    const [templateBytes, thumbnailBytes] = await Promise.all([
      template.arrayBuffer(),
      thumbnail.arrayBuffer(),
    ]);
    const bytes = Uint8Array.from(renderPreview(templateBytes, thumbnailBytes, background));
    if (cache !== null && cacheKey !== null) {
      const cached = new Response(bytes, {
        headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "image/png" },
      });
      await cache.put(cacheKey, cached).catch(() => null);
    }
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  } catch {
    return null;
  }
}
