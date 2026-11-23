import type { EngineName } from "../../src/text-result";

// What this device can read text off images with (README, "Text in
// images"). Both engines need a worker that decodes and draws images
// (createImageBitmap, OffscreenCanvas) and WebAssembly; PP-OCR's runtime
// also needs WebAssembly SIMD. A weak device, or one saving data, runs
// Tesseract alone.

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

// Data saver on, or a mobile connection the browser names as such.
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
