import { chromium, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FONT = new URL("../client/src/theme/fonts/outfit-latin.woff2", import.meta.url);
const TABLE = new URL("../client/src/dice-numeral-centres.ts", import.meta.url);
const WEIGHT = 700;

const round = (value: number) => Math.round(value * 1e4) / 1e4;

export type DigitInk = { area: number; x: number };
export type Measured = { digits: Record<string, DigitInk>; top: number };

/** Measures ink at 1,000 px per em, with area in em² and positions in em. */
export async function measureDigits(page: Page): Promise<Measured> {
  const font = readFileSync(FONT).toString("base64");
  await page.setContent("<!doctype html><title>numerals</title>");
  const weighed = await page.evaluate(
    async ({ data, weight }) => {
      const face = new FontFace("Numerals", `url(data:font/woff2;base64,${data})`, {
        weight: "100 900",
      });
      document.fonts.add(await face.load());
      const em = 1000;
      const origin = 300;
      const canvas = document.createElement("canvas");
      canvas.width = em + 2 * origin;
      canvas.height = em + 2 * origin;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.font = `${weight} ${em}px "Numerals"`;
      const weigh = (digit: string) => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillText(digit, origin, origin + em);
        const { data: pixels, width } = context.getImageData(0, 0, canvas.width, canvas.height);
        let mass = 0;
        let moment = 0;
        let top = canvas.height;
        for (let at = 3; at < pixels.length; at += 4) {
          const cover = pixels[at]! / 255;
          if (cover === 0) continue;
          const pixel = (at - 3) / 4;
          mass += cover;
          moment += cover * ((pixel % width) + 0.5);
          if (cover > 0.5) top = Math.min(top, Math.floor(pixel / width));
        }
        return {
          area: mass / (em * em),
          top: (origin + em - top) / em,
          x: (moment / mass - origin) / em,
        };
      };
      return { digits: [..."0123456789"].map((digit) => weigh(digit)), top: weigh("7").top };
    },
    { data: font, weight: WEIGHT },
  );
  return {
    digits: Object.fromEntries(
      weighed.digits.map(({ area, x }, digit) => [
        String(digit),
        { area: round(area), x: round(x) },
      ]),
    ),
    top: round(weighed.top),
  };
}

export function tableSource({ digits, top }: Measured): string {
  const rows = Object.entries(digits).map(
    ([digit, { area, x }]) => `  ${digit}: { area: ${area}, x: ${x} },`,
  );
  return [
    `/** Outfit ${WEIGHT} digit ink area in em² and centroid x from the glyph origin in em. Regenerate with e2e/numeral-centres.ts. */`,
    "export const DIGIT_INK: Record<string, { area: number; x: number }> = {",
    ...rows,
    "};",
    "",
    "/** Height of a flat-topped digit in em. */",
    `export const DIGIT_TOP = ${top};`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ chromiumSandbox: false });
  writeFileSync(TABLE, tableSource(await measureDigits(await browser.newPage())));
  await browser.close();
}
