import type { EngineName } from "../../src/text-result";

/** Maximum image long side before either OCR engine reads it. */
export const MAX_SIDE = 2048;
/** Settings recorded with each engine’s reading. */
export const PARAMS: Record<EngineName, Record<string, number>> = {
  ppocr: { detMaxSide: 960, maxSide: MAX_SIDE },
  tesseract: { maxSide: MAX_SIDE, psm: 11 },
};

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
