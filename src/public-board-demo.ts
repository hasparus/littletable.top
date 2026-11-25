import type { TLSyncStorage } from "@tldraw/sync-core";
import type { TLImageAsset, TLImageShape, TLRecord } from "@tldraw/tlschema";

import { isShape } from "@tldraw/tlschema";
import { getIndexBelow, sortByIndex } from "@tldraw/utils";

import type { FileLedger } from "./file-store";

import { PUBLIC_DEMO_ASSET, PUBLIC_DEMO_SHAPE } from "./public-board-demo-ids";

const PATH = "/landing-north-gate.png";

const WIDTH = 640;
const HEIGHT = 216;

// The handout uses the same file store and OCR pipeline as guest images.
// Its fixed ids give existing rooms the same handout on their next visit.
export async function seedPublicDemo(
  drawing: TLSyncStorage<TLRecord>,
  assets: Fetcher,
  files: FileLedger,
  board: string,
): Promise<void> {
  const { asset, placed } = drawing.transaction((store) => {
    const shape = store.get(PUBLIC_DEMO_SHAPE);
    return {
      asset: store.get(PUBLIC_DEMO_ASSET),
      placed: shape?.typeName === "shape" && store.get(shape.parentId)?.typeName === "page",
    };
  }).result;
  if (asset?.typeName === "asset" && placed) return;

  let image = asset;
  if (image?.typeName !== "asset") {
    const png = await assets.fetch(new URL(PATH, "https://tabletop.invalid"));
    if (!png.ok) throw new Error(`Handout asset returned ${png.status}`);
    const stored = await files.store(board, "system:public-demo", await png.arrayBuffer());
    if (typeof stored === "string") throw new TypeError(`Handout upload refused (${stored})`);
    const record = {
      id: PUBLIC_DEMO_ASSET,
      meta: {},
      props: {
        fileSize: stored.bytes,
        h: HEIGHT,
        isAnimated: false,
        mimeType: stored.type,
        name: "North Gate note",
        src: `/rooms/${board}/files/${stored.hash}`,
        w: WIDTH,
      },
      type: "image",
      typeName: "asset",
    } satisfies TLImageAsset;
    image = record;
  }

  drawing.transaction((store) => {
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
    store.set(image.id, image);
    store.set(shape.id, shape);
  });
}
