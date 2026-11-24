import { type BrowserType, chromium, expect, firefox, test, webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { hashThrow, simulate } from "../../client/src/dice-physics";
import { bodiesOf } from "../../client/src/dice-throw";

// Every client of a board turns the server's seed into the same throw, so
// players see the same dice land in the same places. This runs the client's
// own simulation, bundled as it ships, in each browser engine and compares
// every throw's frame hash with Node's (V8). The artifact is the list of
// throws that differ, printed when it fails.

const SIDES = [4, 6, 8, 10, 12, 20, 100];
const THROWS = 200;

// NOTE: the typed array turns Math.imul's signed result into the unsigned
// seed the server draws.
const seeds = Uint32Array.from({ length: THROWS }, (_, i) => Math.imul(i + 1, 2_654_435_761));

// Mixed pools of 1 to 20 dice, d100s among them; every fifth is a crowd of
// 11 to 20 dice, mostly d100s, whose balls are thrown smaller.
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
