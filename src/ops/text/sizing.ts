import { type FontFamily, measureRichText } from "./measure";

// How tldraw 5.6's default shape utils size their text, restated for the
// server: the same font sizes, paddings and limits (read from tldraw's
// GeoShapeUtil, NoteShapeUtil and TextShapeUtil), applied to our measurer.
// A connected browser does not redo this for shapes a peer or the server
// wrote: tldraw runs onBeforeCreate only for its own createShapes, so a
// geo shape's growY or a note's font adjustment is whatever the record says.

export type SizeStyle = "l" | "m" | "s" | "xl";

type RichText = { content: unknown[] };

const BASE_FONT_SIZE = 16;
const LINE_HEIGHT = 1.35;
const BASE_STROKE = 2;
export const LABEL_PADDING = 16;

const TEXT_SIZE: Record<SizeStyle, number> = { l: 2.25, m: 1.5, s: 1.125, xl: 2.75 };
const LABEL_SIZE: Record<SizeStyle, number> = { l: 1.625, m: 1.375, s: 1.125, xl: 2 };
export const ARROW_LABEL_SIZE: Record<SizeStyle, number> = { l: 1.5, m: 1.25, s: 1.125, xl: 1.75 };
const STROKE: Record<SizeStyle, number> = { l: 2.5, m: 1.75, s: 1, xl: 5 };
const GEO_LABEL_MIN_WIDTH: Record<SizeStyle, number> = { l: 16, m: 14, s: 12, xl: 20 };

export const NOTE_SIDE = 200;
const NOTE_MIN_FONT_SIZE = 14;

export const labelFontSize = (size: SizeStyle) => BASE_FONT_SIZE * LABEL_SIZE[size];
export const textFontSize = (size: SizeStyle) => BASE_FONT_SIZE * TEXT_SIZE[size];
export const strokeWidth = (size: SizeStyle) => BASE_STROKE * STROKE[size];

export function isEmptyRichText(richText: RichText): boolean {
  if (richText.content.length === 0) return true;
  if (richText.content.length > 1) return false;
  const [only] = richText.content as { content?: unknown[] }[];
  return only?.content === undefined || only.content.length === 0;
}

type Style = { font: FontFamily; size: SizeStyle };

/** The label box of a geo shape `w` wide (unscaled), padding included. */
export function geoLabelSize(richText: RichText, { font, size, w }: Style & { w: number }) {
  const minWidth = GEO_LABEL_MIN_WIDTH[size];
  const measured = measureRichText(richText, {
    family: font,
    fontSize: labelFontSize(size),
    lineHeight: LINE_HEIGHT,
    maxWidth: Math.max(
      0,
      Math.ceil(minWidth + strokeWidth(size)),
      Math.ceil(w - LABEL_PADDING * 2),
    ),
    minWidth,
  });
  return {
    approximate: measured.approximate,
    h: measured.h + LABEL_PADDING * 2,
    w: measured.w + LABEL_PADDING * 2,
  };
}

/** What tldraw's onBeforeCreate makes the growY of a new geo shape. */
export function geoGrowY(richText: RichText, style: Style & { h: number; w: number }) {
  if (isEmptyRichText(richText)) return { approximate: false, growY: 0 };
  const label = geoLabelSize(richText, style);
  return { approximate: label.approximate, growY: Math.max(0, label.h - style.h) };
}

/** A note's growY and font-size adjustment, as tldraw's note util finds them. */
export function noteSizing(richText: RichText, { font, size }: Style) {
  const unadjusted = labelFontSize(size);
  const lineHeight = Math.round(unadjusted * LINE_HEIGHT);
  if (isEmptyRichText(richText)) {
    return { approximate: false, fontSizeAdjustment: 1, growY: 0, labelHeight: lineHeight + 32 };
  }
  // NOTE: tldraw leaves one pixel of give for a measuring fuzz (its FUZZ).
  const maxWidth = NOTE_SIDE - LABEL_PADDING * 2 - 1;
  let fontSize = unadjusted;
  let labelHeight = NOTE_SIDE;
  let approximate = false;
  for (let iteration = 0; iteration <= 50; iteration++) {
    fontSize = Math.min(unadjusted, unadjusted - iteration);
    const measured = measureRichText(richText, {
      family: font,
      fontSize,
      lineHeight: LINE_HEIGHT,
      maxWidth,
      overflowWrap: false,
    });
    approximate ||= measured.approximate;
    labelHeight = measured.h + LABEL_PADDING * 2;
    if (fontSize <= NOTE_MIN_FONT_SIZE) {
      const wrapped = measureRichText(richText, {
        family: font,
        fontSize,
        lineHeight: LINE_HEIGHT,
        maxWidth,
      });
      labelHeight = wrapped.h + LABEL_PADDING * 2;
      break;
    }
    if (measured.scrollWidth.toFixed(0) === measured.w.toFixed(0)) break;
  }
  return {
    approximate,
    fontSizeAdjustment: fontSize === unadjusted ? 1 : fontSize / unadjusted,
    growY: Math.max(0, labelHeight - NOTE_SIDE),
    labelHeight,
  };
}

/** A text shape's size, unscaled: auto-sized, or wrapped at a fixed width. */
export function textShapeSize(
  richText: RichText,
  { autoSize, font, size, w }: Style & { autoSize: boolean; w: number },
) {
  const fontSize = textFontSize(size);
  const minWidth = 16;
  const fixed = autoSize ? null : Math.max(minWidth, Math.floor(w));
  const measured = measureRichText(richText, {
    family: font,
    fontSize,
    lineHeight: LINE_HEIGHT,
    maxWidth: fixed,
  });
  return {
    approximate: measured.approximate,
    h: Math.max(fontSize, measured.h),
    lines: measured.lines,
    w: fixed ?? Math.max(minWidth, measured.w + 1),
  };
}
