import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

import { BOLD_LABELS, FAMILIES, LABELS, SIZES } from "./corpus";

// What e2e/measure/harness.tsx puts on the page.
type Harness = { harness?: { collect: (cases: unknown[]) => object[] } };

const FIXTURES = new URL("../../test/ops/fixtures/", import.meta.url);

type RichText = { content: unknown[]; type: string };

const plain = (text: string): RichText => ({
  content: text
    .split("\n")
    .map((line) =>
      line === ""
        ? { type: "paragraph" }
        : { content: [{ text: line, type: "text" }], type: "paragraph" },
    ),
  type: "doc",
});

const bold = (parts: { bold: boolean; text: string }[]): RichText => ({
  content: [
    {
      content: parts.map(({ bold: isBold, text }) =>
        isBold ? { marks: [{ type: "bold" }], text, type: "text" } : { text, type: "text" },
      ),
      type: "paragraph",
    },
  ],
  type: "doc",
});

test("the real editor's text sizes", async ({ page }, info) => {
  await page.goto("/");
  await page.waitForFunction(() => (globalThis as unknown as Harness).harness !== undefined, null, {
    timeout: 60_000,
  });
  const cases = [
    ...LABELS.flatMap(({ kind, text }) =>
      FAMILIES.flatMap((family) =>
        SIZES.map((size) => ({ family, kind, richText: plain(text), size })),
      ),
    ),
    ...BOLD_LABELS.flatMap(({ kind, parts }) =>
      FAMILIES.flatMap((family) =>
        SIZES.map((size) => ({ family, kind, richText: bold(parts), size })),
      ),
    ),
  ];
  const results = await page.evaluate(
    (all) => (globalThis as unknown as Harness).harness!.collect(all),
    cases,
  );
  expect(results).toHaveLength(cases.length);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(
    new URL(`browser-text.${info.project.name}.json`, FIXTURES),
    `${JSON.stringify({ cases: results.map((result, index) => ({ ...result, kind: cases[index]!.kind })), tldraw: "5.6.0", userAgent })}\n`,
  );
});
