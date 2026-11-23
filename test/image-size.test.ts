import { describe, expect, it } from "vitest";

import { imageDimensions } from "../src/image-size";
import { IMAGES_37_BY_21 } from "./image-samples";

// How reading an image's size goes wrong: a format's header misread (the
// wrong field, the wrong byte order), a JPEG frame missed behind metadata
// or a progressive frame's other marker, a WebP's other two headers, an
// AVIF's thumbnail taken for the image, a cut-short or hostile header
// that reads past the bytes or loops, and a type with no size (SVG).

describe("an image's size, from the start of its bytes", () => {
  it.each(Object.keys(IMAGES_37_BY_21))("reads %s", (name) => {
    const bytes = IMAGES_37_BY_21[name as keyof typeof IMAGES_37_BY_21];
    expect(imageDimensions(bytes)).toEqual({ height: 21, width: 37 });
  });

  it("reads it from a prefix of the file, as the Worker fetches it", () => {
    const jpeg = IMAGES_37_BY_21["size-exif.jpg"];
    const frame = jpeg.findIndex((byte, at) => byte === 0xff && jpeg[at + 1] === 0xc0);
    expect(imageDimensions(jpeg.subarray(0, frame + 9))).toEqual({ height: 21, width: 37 });
  });

  it("says nothing of a header cut short", () => {
    for (const [name, bytes] of Object.entries(IMAGES_37_BY_21)) {
      const cut = { avif: 60, gif: 8, jpg: 40, png: 20, webp: 20 }[name.split(".")[1]!]!;
      expect(imageDimensions(bytes.subarray(0, cut)), name).toBeNull();
    }
  });

  it("says nothing of an SVG, of text, or of nothing", () => {
    const text = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4"/>');
    expect(imageDimensions(text)).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });

  it("stops at a JPEG segment that claims no length instead of looping", () => {
    const looping = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0xff, 0xe1, 0x00, 0x00]);
    expect(imageDimensions(looping)).toBeNull();
  });

  it("takes an AVIF's primary item, not a property listed before it", () => {
    const avif = IMAGES_37_BY_21["size.avif"];
    const view = new DataView(avif.buffer, avif.byteOffset, avif.byteLength);
    const ispe = [...avif.keys()].find(
      (at) => String.fromCodePoint(...avif.subarray(at, at + 4)) === "ispe",
    )!;
    // An item other than the primary one, as a thumbnail would be.
    const pitm = [...avif.keys()].find(
      (at) => String.fromCodePoint(...avif.subarray(at, at + 4)) === "pitm",
    )!;
    const other = new Uint8Array(avif);
    new DataView(other.buffer).setUint16(pitm + 8, view.getUint16(pitm + 8) + 7);
    expect(imageDimensions(other)).toBeNull();
    expect(view.getUint32(ispe + 8)).toBe(37);
  });
});
