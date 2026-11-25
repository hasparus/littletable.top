import { type BrowserType, chromium, expect, firefox, test, webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { hashThrow, simulate } from "../../client/src/dice-physics";
import { bodiesOf } from "../../client/src/dice-throw";

const SIDES = [4, 6, 8, 10, 12, 20, 100];
const THROWS = 200;

// WARNING: Keep these seeds unsigned. Math.imul returns signed 32-bit values.
const seeds = Uint32Array.from({ length: THROWS }, (_, i) => Math.imul(i + 1, 2_654_435_761));

const cases = Array.from(seeds, (seed, i) => ({
  kinds: bodiesOf(
    Array.from({ length: i % 5 === 4 ? 11 + (i % 10) : 1 + (i % 20) }, (_, k) => ({
      sides: i % 5 === 4 && k % 4 !== i % 4 ? 100 : SIDES[(i * 7 + k * 3) % SIDES.length]!,
      value: 1,
    })),
  ).map((body) => body.kind),
  seed,
}));

const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

test("every browser engine throws the same dice from the same seed", async () => {
  test.setTimeout(300_000);
  const expected = cases.map(({ kinds, seed }) => hashThrow(simulate(kinds, seed)));
  const bundle = await build({
    build: {
      lib: {
        entry: fileURLToPath(new URL("dice-determinism-entry.ts", import.meta.url)),
        formats: ["iife"],
        name: "dice",
      },
      minify: true,
      write: false,
    },
    configFile: false,
    logLevel: "warn",
  });
  const [output] = Array.isArray(bundle) ? bundle : [bundle];
  if (output === undefined || !("output" in output)) throw new Error("vite built no bundle");
  const [{ code }] = output.output;

  for (const [name, engine] of ENGINES) {
    const browser = await engine.launch();
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>dice</title>");
    await page.addScriptTag({ content: code });
    const hashes = await page.evaluate(
      (all) => all.map(({ kinds, seed }) => globalThis.dice.hash(kinds, seed)),
      cases,
    );
    await browser.close();
    const differing = cases.flatMap((throwCase, i) =>
      hashes[i] === expected[i] ? [] : [{ ...throwCase, engine: name }],
    );
    expect(differing, JSON.stringify(differing.slice(0, 5))).toEqual([]);
  }
});

declare global {
  var dice: { hash: (kinds: string[], seed: number) => string };
}
