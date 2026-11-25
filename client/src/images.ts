import { MediaHelpers } from "tldraw";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The longest side an uploaded photo keeps. A page scanned at 300 dpi
 * (A4 is 2480 × 3508, US Letter 2550 × 3300) stays as it is, small print
 * and all; a phone's 12 MP photo (4032 × 3024) also fits, and a 48 MP one
 * (8064 × 6048) comes down to 4096 × 3072.
 */
export const MAX_IMAGE_SIDE = 4096;

const JPEG_QUALITY = 0.9;
const LOWER_QUALITIES = [0.8, 0.7];

// WARNING: Resizing animated images on a canvas loses their animation frames.
const REDRAWN = new Set(["image/jpeg", "image/png", "image/webp"]);

type Surface = {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  encode: (type: string, quality: number) => Promise<Blob>;
};

function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    return {
      context: canvas.getContext("2d")!,
      encode: (type, quality) => canvas.convertToBlob({ quality, type }),
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    context: canvas.getContext("2d")!,
    encode: (type, quality) =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => {
            if (blob === null) reject(new Error("board: could not encode"));
            else resolve(blob);
          },
          type,
          quality,
        ),
      ),
  };
}

const renamed = (name: string, type: string) =>
  `${name.replace(/\.[^.]*$/u, "")}.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}`;

async function redraw(
  bitmap: ImageBitmap,
  { opaque, scale }: { opaque: boolean; scale: number },
): Promise<Blob[]> {
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const { context, encode } = surface(width, height);
  if (opaque) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  if (opaque) {
    return Promise.all(
      [JPEG_QUALITY, ...LOWER_QUALITIES].map((quality) => encode("image/jpeg", quality)),
    );
  }
  // WARNING: A browser that cannot encode WebP returns a PNG instead. Both formats keep transparency.
  return [await encode("image/webp", JPEG_QUALITY)];
}

/**
 * The file as the board will store it: a photo larger than the pixel
 * budget, or heavier than the Worker takes, is redrawn smaller. The
 * orientation a phone wrote into the photo is applied on the way.
 */
export async function fitForUpload(
  file: File,
  { maxSide = MAX_IMAGE_SIDE }: { maxSide?: number } = {},
): Promise<File> {
  if (!REDRAWN.has(file.type) || (await MediaHelpers.isAnimated(file))) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    let scale = Math.min(1, maxSide / longest);
    if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return file;
    // WARNING: Converting to JPEG discards transparency. Use it only if an alpha-preserving result does not fit.
    for (let tries = 0; tries < 4; tries++) {
      for (const opaque of file.type === "image/jpeg" ? [true] : [false, true]) {
        const encoded = await redraw(bitmap, { opaque, scale });
        const blob = encoded.find((candidate) => candidate.size <= MAX_IMAGE_BYTES);
        if (blob !== undefined) {
          return new File([blob], renamed(file.name, blob.type), { type: blob.type });
        }
      }
      scale *= 0.75;
    }
    return file;
  } finally {
    bitmap.close();
  }
}
