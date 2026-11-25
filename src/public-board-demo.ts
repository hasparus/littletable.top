import type { TLSyncStorage } from "@tldraw/sync-core";
import type { TLImageAsset, TLImageShape, TLRecord } from "@tldraw/tlschema";

import { isShape } from "@tldraw/tlschema";
import { getIndexBelow, sortByIndex } from "@tldraw/utils";

import type { FileLedger } from "./file-store";
import type { Reading, TextLedger } from "./text-store";

import { PUBLIC_DEMO_ASSET, PUBLIC_DEMO_SHAPE } from "./public-board-demo-ids";
import handoutReading from "./public-board-demo-ocr.json";

const PATH = "/landing-north-gate.png";

// Captured from the app's Tesseract worker reading the bundled PNG. Use the
// original pixel geometry and hash so the normal search can highlight the clue.
const ENGINE = "tesseract-6.0.1";
const { height: HEIGHT, sha256: HASH, width: WIDTH } = handoutReading.image;
const SYSTEM = "system:public-demo";

// The handout uses the same file store and OCR pipeline as guest images.
// Its fixed ids give existing rooms the same handout on their next visit.
export async function seedPublicDemo(
  drawing: TLSyncStorage<TLRecord>,
  assets: Fetcher,
  { files, texts }: { files: FileLedger; texts: TextLedger },
  board: string,
): Promise<Reading | null> {
  const src = `/rooms/${board}/files/${HASH}`;
  const { asset, placed } = drawing.transaction((store) => {
    const shape = store.get(PUBLIC_DEMO_SHAPE);
    return {
      asset: store.get(PUBLIC_DEMO_ASSET),
      placed: shape?.typeName === "shape" && store.get(shape.parentId)?.typeName === "page",
    };
  }).result;
  const current = asset?.typeName === "asset" && asset.type === "image" && asset.props.src === src;
  const hasReading = texts.has(HASH, ENGINE);
  if (current && placed && hasReading) return null;

  let image = asset;
  if (!current || image === undefined) {
    const png = await assets.fetch(new URL(PATH, "https://tabletop.invalid"));
    if (!png.ok) throw new Error(`Handout asset returned ${png.status}`);
    const stored = await files.store(board, SYSTEM, await png.arrayBuffer());
    if (typeof stored === "string") throw new TypeError(`Handout upload refused (${stored})`);
    if (stored.hash !== HASH)
      throw new Error("Handout image and OCR reading have different hashes");
    const record = {
      id: PUBLIC_DEMO_ASSET,
      meta: {},
      props: {
        fileSize: stored.bytes,
        h: HEIGHT,
        isAnimated: false,
        mimeType: stored.type,
        name: "North Gate note",
        src,
        w: WIDTH,
      },
      type: "image",
      typeName: "asset",
    } satisfies TLImageAsset;
    image = record;
  }

  let reading: Reading | null = null;
  if (!hasReading) {
    const stored = await texts.store(
      { board, engine: ENGINE, hash: HASH, sub: SYSTEM },
      new TextEncoder().encode(JSON.stringify(handoutReading)).buffer,
      { bytesNow: () => files.storedBytes() },
    );
    if (typeof stored === "string") throw new TypeError(`Handout reading refused (${stored})`);
    if ("problem" in stored) throw new Error(`Handout reading refused (${stored.problem})`);
    if (!stored.duplicate) reading = { engine: ENGINE, hash: HASH };
  }

  drawing.transaction((store) => {
    if (image !== asset) store.set(image.id, image);
    const existing = store.get(PUBLIC_DEMO_SHAPE);
    if (existing?.typeName === "shape" && store.get(existing.parentId)?.typeName === "page") {
      return;
    }
    const records = [...store.values()];
    const page = records.filter((record) => record.typeName === "page").sort(sortByIndex)[0];
    if (page === undefined) return;
    const front = records
      .filter(isShape)
      .filter((shape) => shape.parentId === page.id)
      .sort(sortByIndex)[0];
    const shape = {
      id: PUBLIC_DEMO_SHAPE,
      index: getIndexBelow(front?.index),
      isLocked: true,
      meta: { place: "North Gate" },
      opacity: 1,
      parentId: page.id,
      props: {
        altText: "Note from the north gate",
        assetId: PUBLIC_DEMO_ASSET,
        crop: null,
        flipX: false,
        flipY: false,
        h: HEIGHT / 2,
        playing: false,
        url: "",
        w: WIDTH / 2,
      },
      rotation: 0,
      type: "image",
      typeName: "shape",
      x: 6,
      y: 56,
    } satisfies TLImageShape;
    store.set(shape.id, shape);
  });
  return reading;
}
