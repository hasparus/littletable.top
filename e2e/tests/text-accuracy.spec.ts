import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

import type { TextResult } from "../../src/text-result";

import { HOST, HOSTED } from "../ports";
import { score, type Truth } from "../text-score";
import { collectCspViolations, expectNoCspViolations } from "./helpers";
import { fixture, sha256, uploadImage } from "./tldr";

// How well the real engines read the committed fixtures, in a real
// browser, through the board itself: one person uploads all six, their
// browser reads them, and the stored readings are scored against the
// ground truth. Floors sit a little below what both engines measured
// (docs/internals.md, "Text in images"), so a regression in the pipeline, a model
// or a parameter fails here. Slow (a cold start of both engines and six
// images): `bun run e2e -- --grep @accuracy` runs it alone. The
// artifact is accuracy.json, every score.

type Floor = { diacritics: number; names: number; tesseractLocated: number };

const FLOORS: Record<string, Floor> = {
  handout_pl_photo: { diacritics: 0.95, names: 0.95, tesseractLocated: 0.9 },
  map_pl: { diacritics: 0.3, names: 0.65, tesseractLocated: 0.15 },
  rules_pl: { diacritics: 0.95, names: 0.95, tesseractLocated: 0.9 },
  sheet_pl_clean: { diacritics: 0.95, names: 0.95, tesseractLocated: 0.95 },
  sheet_pl_scan: { diacritics: 0.8, names: 0.95, tesseractLocated: 0.7 },
  small_card_pl: { diacritics: 0.95, names: 0.95, tesseractLocated: 0.95 },
};
const IMAGES = {
  handout_pl_photo: "handout_pl_photo.jpg",
  map_pl: "map_pl.jpg",
  rules_pl: "rules_pl.png",
  sheet_pl_clean: "sheet_pl_clean.png",
  sheet_pl_scan: "sheet_pl_scan.jpg",
  small_card_pl: "small_card_pl.png",
};

const words = (readings: TextResult[]) =>
  readings.flatMap((reading) =>
    reading.lines.flatMap((line) => line.words.map((word) => ({ box: word.b, text: word.t }))),
  );

test(
  "both engines read the fixtures as well as they did",
  { tag: "@accuracy" },
  async ({ page }) => {
    test.setTimeout(600_000);
    await collectCspViolations(page);
    await page.goto(`${HOST}/sign-in?name=Ola`);
    await page.getByRole("button", { name: "New board" }).click();
    await expect(page.getByRole("button", { exact: true, name: "Dice" })).toBeVisible();
    for (const image of Object.values(IMAGES)) await uploadImage(page, `text/${image}`);

    // The board's id, from where its images load.
    const src = await page
      .getByTestId("canvas")
      .locator("img.tl-image")
      .first()
      .evaluate((image) => new URL((image as HTMLImageElement).src).pathname);
    const files = src.slice(0, src.lastIndexOf("/"));
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`${HOSTED}${files}/text`);
          const listing = (await response.json()) as { stored: unknown[] };
          return listing.stored.length;
        },
        { intervals: [2000], timeout: 480_000 },
      )
      .toBe(2 * Object.keys(IMAGES).length);

    const scores: Record<string, unknown> = {};
    for (const [name, image] of Object.entries(IMAGES)) {
      const hash = sha256(readFileSync(fixture(`text/${image}`)));
      const readings = await Promise.all(
        ["tesseract-6.0.1", "ppocr-v6tiny.1"].map(async (engine) => {
          const response = await page.request.get(`${HOSTED}${files}/${hash}/text/${engine}`);
          return (await response.json()) as TextResult;
        }),
      );
      const truth = JSON.parse(readFileSync(fixture(`text/${name}.gt.json`), "utf8")) as Truth;
      const both = score(truth, words(readings));
      const tesseract = score(
        truth,
        words(readings.filter((reading) => reading.engine.name === "tesseract")),
      );
      scores[name] = { both, tesseract };
      const floor = FLOORS[name]!;
      expect
        .soft(both.names, `${name}: names found (missed ${both.namesMissed.join(", ")})`)
        .toBeGreaterThanOrEqual(floor.names);
      expect
        .soft(both.diacritics ?? 1, `${name}: Polish diacritics kept`)
        .toBeGreaterThanOrEqual(floor.diacritics);
      expect
        .soft(tesseract.located, `${name}: Tesseract words located`)
        .toBeGreaterThanOrEqual(floor.tesseractLocated);
    }
    writeFileSync(test.info().outputPath("accuracy.json"), JSON.stringify(scores, null, 2));
    await expectNoCspViolations(page);
  },
);
