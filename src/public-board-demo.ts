import type { TLSyncStorage } from "@tldraw/sync-core";
import type { TLImageAsset, TLRecord } from "@tldraw/tlschema";

import { getIndexBelow, sortByIndex } from "@tldraw/utils";

import type { FileLedger } from "./file-store";
import type { Reading, TextLedger } from "./text-store";

import { PUBLIC_HANDOUT_ASSET, PUBLIC_HANDOUT } from "./public-board-demo-ids";
import handoutReading from "./public-board-demo-ocr.json";

const PATH = "/landing-north-gate.png";

const ENGINE = "tesseract-6.0.1";
const { height: HEIGHT, sha256: HASH, width: WIDTH } = handoutReading.image;
const SYSTEM = "system:public-demo";
const HANDOUT_X = 552;
const HANDOUT_Y = 56;

/** Seeds the bundled handout and its Tesseract result through the same ledgers as guest images. */
export async function seedPublicDemo(
  drawing: TLSyncStorage<TLRecord>,
  assets: Fetcher,
  { files, texts }: { files: FileLedger; texts: TextLedger },
  board: string,
) {
  const src = `/rooms/${board}/files/${HASH}`;
  const { asset, placed } = drawing.transaction((store) => {
    const handout = store.get(PUBLIC_HANDOUT);
    return {
      asset: store.get(PUBLIC_HANDOUT_ASSET),
      placed:
        handout?.typeName === "shape" &&
        handout.x === HANDOUT_X &&
        handout.y === HANDOUT_Y &&
        store.get(handout.parentId)?.typeName === "page",
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The ledger returns a refusal code as a string.
    if (typeof stored === "string") throw new TypeError(`Handout upload refused (${stored})`);
    if (stored.hash !== HASH)
      throw new Error("Handout image and OCR reading have different hashes");
    const record = {
      id: PUBLIC_HANDOUT_ASSET,
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The ledger returns a refusal code as a string.
    if (typeof stored === "string") throw new TypeError(`Handout reading refused (${stored})`);
    if ("problem" in stored) throw new Error(`Handout reading refused (${stored.problem})`);
    if (!stored.duplicate) reading = { engine: ENGINE, hash: HASH };
  }

  drawing.transaction((store) => {
    if (image !== asset) store.set(image.id, image);
    const existing = store.get(PUBLIC_HANDOUT);
    if (existing?.typeName === "shape" && store.get(existing.parentId)?.typeName === "page") {
      store.set(existing.id, { ...existing, x: HANDOUT_X, y: HANDOUT_Y });
      return;
    }
    const records = [...store.values()];
    const page = records.filter((record) => record.typeName === "page").sort(sortByIndex)[0];
    if (page === undefined) return;
    const front = records
      .filter((record) => record.typeName === "shape")
      .filter((drawing) => drawing.parentId === page.id)
      .sort(sortByIndex)[0];
    const handout = {
      id: PUBLIC_HANDOUT,
      index: getIndexBelow(front?.index),
      isLocked: true,
      meta: { place: "North Gate" },
      opacity: 1,
      parentId: page.id,
      props: {
        altText: "Note from the north gate",
        assetId: PUBLIC_HANDOUT_ASSET,
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
      x: HANDOUT_X,
      y: HANDOUT_Y,
    } satisfies TLRecord;
    store.set(handout.id, handout);
  });
  return reading;
}
