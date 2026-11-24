// How large an image is, read from the start of its bytes: PNG, JPEG,
// WebP, GIF and AVIF. The Worker checks a text reading's stated size
// against it (src/text-store.ts), so it never decodes an image. A JPEG's
// size is as it shows: its EXIF orientation applied, as browsers apply it.
// NOTE: PNG and WebP may carry EXIF too, and AVIF a rotation (irot, imir)
// and a crop (clap); those are not read, so for them `exact` is false.

export type Dimensions = { height: number; width: number };
export type Shown = Dimensions & { exact: boolean };

// The most of an image's start the reader needs: a JPEG's frame header can
// sit behind tens of kilobytes of metadata and a thumbnail.
export const SIZE_PREFIX_BYTES = 256 * 1024;

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCodePoint(...bytes.subarray(from, Math.min(to, bytes.length)));

const sized = (width: number, height: number): Dimensions | null =>
  width > 0 && height > 0 ? { height, width } : null;

function png(view: DataView, bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return null;
  return sized(view.getUint32(16), view.getUint32(20));
}

function gif(view: DataView, bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  return sized(view.getUint16(6, true), view.getUint16(8, true));
}

// JPEG markers, by the byte after FF: start of image (D8), the frames
// (C0 to CF but for C4, Huffman tables, C8, reserved, and CC, arithmetic
// coding conditions), restarts (D0 to D7) and TEM (01), which carry no
// length, and start of scan (DA) and end of image (D9), past which no
// frame header comes.
const MARK = 255;
const START = 216;
const [SOF0, SOF15, DHT, JPG, DAC] = [192, 207, 196, 200, 204];
const [RST0, RST7, TEM, EOI, SOS] = [208, 215, 1, 217, 218];

const isFrame = (marker: number) =>
  marker >= SOF0 && marker <= SOF15 && marker !== DHT && marker !== JPG && marker !== DAC;

const APP1 = 225;
const ORIENTATION_TAG = 274;
// EXIF orientations 5 to 8 turn the image a quarter.
const TURNS_QUARTER = 5;

// The orientation an APP1 segment's EXIF block names, from its first IFD;
// 1, upright, when it names none.
function exifOrientation(view: DataView, bytes: Uint8Array, start: number, end: number): number {
  if (ascii(bytes, start, start + 6) !== "Exif\u0000\u0000") return 1;
  const tiff = start + 6;
  const order = ascii(bytes, tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const little = order === "II";
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const entries = view.getUint16(ifd, little);
  for (let entry = 0; entry < entries; entry++) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > end) return 1;
    if (view.getUint16(at, little) === ORIENTATION_TAG) return view.getUint16(at + 8, little);
  }
  return 1;
}

function jpeg(view: DataView, bytes: Uint8Array): Dimensions | null {
  let at = 2;
  let orientation = 1;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== MARK) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes, and markers that carry no length.
    if (marker === MARK) {
      at += 1;
      continue;
    }
    if (marker === TEM || (marker >= RST0 && marker <= RST7)) {
      at += 2;
      continue;
    }
    if (marker === EOI || marker === SOS) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    if (marker === APP1 && orientation === 1) {
      orientation = exifOrientation(view, bytes, at + 4, Math.min(at + 2 + length, bytes.length));
    }
    if (isFrame(marker)) {
      if (at + 9 > bytes.length) return null;
      const [width, height] = [view.getUint16(at + 7), view.getUint16(at + 5)];
      return orientation >= TURNS_QUARTER && orientation <= 8
        ? sized(height, width)
        : sized(width, height);
    }
    at += 2 + length;
  }
  return null;
}

// A lossless frame's signature byte, and a lossy one's start code.
const VP8L_SIGNATURE = 47;
const VP8_START = [157, 1, 42];
// Sizes of 14 bits (WebP), and property indexes of 7 or 15 (AVIF).
const LOW_14 = 2 ** 14 - 1;
const LOW_7 = 2 ** 7 - 1;
const LOW_15 = 2 ** 15 - 1;

function webp(view: DataView, bytes: Uint8Array): Dimensions | null {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + (view.getUint16(24, true) | (bytes[26]! << 16));
    const height = 1 + (view.getUint16(27, true) | (bytes[29]! << 16));
    return sized(width, height);
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === VP8L_SIGNATURE) {
    const bits = view.getUint32(21, true);
    return sized((bits & LOW_14) + 1, ((bits >>> 14) & LOW_14) + 1);
  }
  // A lossy frame: a start code, then 14-bit sizes and 2-bit scales.
  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    VP8_START.every((byte, at) => bytes[23 + at] === byte)
  ) {
    return sized(view.getUint16(26, true) & LOW_14, view.getUint16(28, true) & LOW_14);
  }
  return null;
}

type Box = { end: number; start: number; type: string };

// The boxes of an ISO media file between `from` and `to`.
function boxes(view: DataView, bytes: Uint8Array, from: number, to: number): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    found.push({ end: at + size, start: at + header, type: ascii(bytes, at + 4, at + 8) });
    at += size;
  }
  return found;
}

const child = (list: Box[], type: string) => list.find((box) => box.type === type);

// An AVIF's size is its primary item's "ispe" property: meta names the
// primary item (pitm), lists the properties (iprp/ipco) and says which
// belong to which item (iprp/ipma).
function avif(view: DataView, bytes: Uint8Array): Dimensions | null {
  const meta = child(boxes(view, bytes, 0, bytes.length), "meta");
  if (meta === undefined) return null;
  // NOTE: meta is a full box: four bytes of version and flags first.
  const inMeta = boxes(view, bytes, meta.start + 4, meta.end);
  const pitm = child(inMeta, "pitm");
  const iprp = child(inMeta, "iprp");
  if (pitm === undefined || iprp === undefined) return null;
  const primary =
    bytes[pitm.start] === 0 ? view.getUint16(pitm.start + 4) : view.getUint32(pitm.start + 4);
  const inIprp = boxes(view, bytes, iprp.start, iprp.end);
  const ipco = child(inIprp, "ipco");
  const ipma = child(inIprp, "ipma");
  if (ipco === undefined || ipma === undefined) return null;
  const properties = boxes(view, bytes, ipco.start, ipco.end);
  const version = bytes[ipma.start]!;
  const wideIndex = (bytes[ipma.start + 3]! & 1) === 1;
  let at = ipma.start + 4;
  const entries = view.getUint32(at);
  at += 4;
  for (let entry = 0; entry < entries && at < ipma.end; entry++) {
    const item = version < 1 ? view.getUint16(at) : view.getUint32(at);
    at += version < 1 ? 2 : 4;
    const count = bytes[at]!;
    at += 1;
    for (let association = 0; association < count; association++) {
      const index = wideIndex ? view.getUint16(at) & LOW_15 : bytes[at]! & LOW_7;
      at += wideIndex ? 2 : 1;
      const property = properties[index - 1];
      if (item === primary && property?.type === "ispe" && property.start + 12 <= property.end) {
        return sized(view.getUint32(property.start + 4), view.getUint32(property.start + 8));
      }
    }
  }
  return null;
}

// The size the image's header states, or null for anything else (an SVG
// has none) or a header cut short. Orientation is not applied: a JPEG's
// EXIF orientation or an AVIF's rotation can show it the other way up.
const exactly = (size: Dimensions | null, exact: boolean): Shown | null =>
  size === null ? null : { ...size, exact };

export function imageDimensions(bytes: Uint8Array): Shown | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (ascii(bytes, 0, 8) === "\u0089PNG\r\n\u001A\n") return exactly(png(view, bytes), false);
    if (bytes[0] === MARK && bytes[1] === START) return exactly(jpeg(view, bytes), true);
    if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
      return exactly(gif(view, bytes), true);
    }
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
      return exactly(webp(view, bytes), false);
    }
    if (ascii(bytes, 4, 8) === "ftyp") return exactly(avif(view, bytes), false);
  } catch (error) {
    // A length that runs past the bytes: a damaged or cut-short header.
    if (error instanceof RangeError) return null;
    throw error;
  }
  return null;
}
