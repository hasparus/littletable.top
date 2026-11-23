import { expect, test } from "@playwright/test";

import { DIGIT_INK, DIGIT_TOP } from "../../client/src/dice-numeral-centres";
import { measureDigits } from "../numeral-centres";

// The dice centre their numerals by a table of where each digit's ink sits.
// What can go wrong: the font file or its weight changes and the table is
// left behind, so numerals drift off their faces. This measures the font as
// it ships and compares.

// A thousandth of the em: under a tenth of a pixel on the largest die.
const TOLERANCE = 0.001;

test("the digit ink table matches the font the numerals are drawn in", async ({ page }) => {
  const { digits, top } = await measureDigits(page);
  expect(Object.keys(digits)).toEqual(Object.keys(DIGIT_INK));
  for (const [digit, { area, x }] of Object.entries(digits)) {
    expect(Math.abs(area - DIGIT_INK[digit]!.area), `area of ${digit}`).toBeLessThan(TOLERANCE);
    expect(Math.abs(x - DIGIT_INK[digit]!.x), `centre of ${digit}`).toBeLessThan(TOLERANCE);
  }
  expect(Math.abs(top - DIGIT_TOP)).toBeLessThan(TOLERANCE);
});
