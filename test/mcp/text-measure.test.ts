import { describe, expect, it } from "vitest";

import { type FontFamily, measureRichText } from "../../src/ops/text/measure";
import {
  geoGrowY,
  labelFontSize,
  noteSizing,
  type SizeStyle,
  textShapeSize,
} from "../../src/ops/text/sizing";
import chromiumHinted from "./fixtures/browser-text.chromium-hinted.json";
import chromium from "./fixtures/browser-text.chromium.json";
import firefox from "./fixtures/browser-text.firefox.json";
import webkit from "./fixtures/browser-text.webkit.json";

// Compares the server-side measurer with what the real tldraw editor
// answered for the same labels in four browsers (e2e/measure). "chromium"
// is the reference: Chrome with font hinting off, which lays text out as it
// does on macOS, Windows and Android.

type Fixture = typeof chromium;
type Case = Fixture["cases"][number];

// Glyphs no tldraw font has: a browser draws them from the reader's system
// fonts, so the server can only estimate them.
const FALLBACK_KINDS = new Set(["cjk", "emoji"]);

const lineHeightOf = (px: number) => Math.round(px * 1.35);

type Row = { kind: string; metric: string; ours: number; theirs: number; what: string };

function compare(fixture: Fixture): Row[] {
  const out: Row[] = [];
  for (const c of fixture.cases as Case[]) {
    const font = c.family as FontFamily;
    const size = c.size as SizeStyle;
    const push = (metric: string, ours: number, theirs: number) =>
      out.push({
        kind: c.kind,
        metric,
        ours,
        theirs,
        what: `${font}/${size} ${JSON.stringify(c.richText.content).slice(0, 70)}`,
      });
    const options = { family: font, fontSize: labelFontSize(size), lineHeight: 1.35 };
    push(
      "label width",
      measureRichText(c.richText, { ...options, maxWidth: null }).w,
      c.label.unwrapped.w,
    );
    push(
      "label lines at 168px",
      measureRichText(c.richText, { ...options, maxWidth: 168 }).lines,
      c.label.wrapped168.h / lineHeightOf(options.fontSize),
    );
    const text = textShapeSize(c.richText, { autoSize: true, font, size, w: 0 });
    push("text shape width", text.w, c.text.auto.w);
    push("text shape height", text.h, c.text.auto.h);
    push(
      "text 220px wide, height",
      textShapeSize(c.richText, { autoSize: false, font, size, w: 220 }).h,
      c.text.fixed220.h,
    );
    push(
      "geo 200x100 growY",
      geoGrowY(c.richText, { font, h: 100, size, w: 200 }).growY,
      c.geo.growY,
    );
    const note = noteSizing(c.richText, { font, size });
    push("note growY", note.growY, c.note.growY);
    push("note fontSizeAdjustment", note.fontSizeAdjustment, c.note.fontSizeAdjustment);
  }
  return out;
}

// NOTE: a width is "exact" within half a pixel; counts and growY are
// whole numbers.
const exact = (row: Row) => Math.abs(row.ours - row.theirs) < 0.5;

function summary(name: string, rows: Row[]): string[] {
  const lines: string[] = [];
  for (const metric of [...new Set(rows.map((row) => row.metric))]) {
    for (const fallback of [false, true]) {
      const errors = rows
        .filter((row) => row.metric === metric && FALLBACK_KINDS.has(row.kind) === fallback)
        .map((row) => Math.abs(row.ours - row.theirs))
        .sort((a, b) => a - b);
      const hits = errors.filter((error) => error < 0.5).length;
      const at = (q: number) => errors[Math.min(errors.length - 1, Math.floor(q * errors.length))]!;
      lines.push(
        `| ${name} | ${metric} | ${fallback ? "CJK, emoji" : "tldraw fonts"} | ${errors.length} | ${((100 * hits) / errors.length).toFixed(1)}% | ${at(0.5).toFixed(2)} | ${at(0.95).toFixed(2)} | ${errors.at(-1)!.toFixed(2)} |`,
      );
    }
  }
  return lines;
}

const BROWSERS = { chromium, "chromium-hinted": chromiumHinted, firefox, webkit } as Record<
  string,
  Fixture
>;

describe("the server-side measurer against the real tldraw editor", () => {
  const results = Object.fromEntries(
    Object.entries(BROWSERS).map(([name, fixture]) => [name, compare(fixture)]),
  );

  it("prints the error table (vitest --disableConsoleIntercept)", () => {
    console.log(
      [
        "| browser | metric | glyphs | n | exact | median error | p95 | max |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...Object.entries(results).flatMap(([name, rows]) => summary(name, rows)),
      ].join("\n"),
    );
  });

  it("gives the reference browser's line counts, heights and growY exactly for tldraw's fonts", () => {
    const counted = results.chromium!.filter(
      (row) => !FALLBACK_KINDS.has(row.kind) && !row.metric.includes("width"),
    );
    expect(counted.filter((row) => !exact(row)).map((row) => `${row.metric} ${row.what}`)).toEqual(
      [],
    );
  });

  it("is within 2 px of the reference browser's widths for tldraw's fonts", () => {
    const widths = results.chromium!.filter(
      (row) => !FALLBACK_KINDS.has(row.kind) && row.metric.includes("width"),
    );
    expect(widths.filter((row) => Math.abs(row.ours - row.theirs) >= 2)).toEqual([]);
  });
});
