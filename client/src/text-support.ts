import type { EngineName } from "../../src/text-result";

// What this device can read text off images with (docs/internals.md, "Text in
// images"). Both engines need a worker that decodes and draws images
// (createImageBitmap, OffscreenCanvas) and WebAssembly; PP-OCR's runtime
// also needs WebAssembly SIMD. A weak device, or one saving data, runs
// Tesseract alone.

// Both engines read a picture of at most this long a side; Tesseract's
// accuracy stops growing there, and the detector looks at 960 px anyway.
export const MAX_SIDE = 2048;
// What each engine's reading says it was read with.
export const PARAMS: Record<EngineName, Record<string, number>> = {
  ppocr: { detMaxSide: 960, maxSide: MAX_SIDE },
  tesseract: { maxSide: MAX_SIDE, psm: 11 },
};

// The smallest module that uses a SIMD instruction (i8x16.splat, then
// i8x16.popcnt), as wasm-feature-detect checks for it.
const SIMD_PROBE = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export function hasSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

type Connection = { saveData?: boolean; type?: string };

const connection = (): Connection | undefined =>
  (navigator as Navigator & { connection?: Connection }).connection;

export function savingData(): boolean {
  const current = connection();
  return current?.saveData === true || current?.type === "cellular";
}

export function textEngines(): EngineName[] {
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap === "undefined" ||
    typeof WebAssembly === "undefined"
  ) {
    return [];
  }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const weak = (memory !== undefined && memory < 4) || connection()?.saveData === true;
  return weak || !hasSimd() ? ["tesseract"] : ["tesseract", "ppocr"];
}
