import { useEffect, useRef } from "react";
import { atom, type Atom, type TLPageId, useEditor, useValue } from "tldraw";

import type { Point } from "./search-index";

import { fill } from "./copy";
import { useBoardUi } from "./ui";

// A polygon in page coordinates to show for a moment: a shape's outline,
// or later the part of an image a line was read from.
export type Flash = { label: string; page: TLPageId; polygon: readonly Point[]; serial: number };

const FLASH_MS = 2600;

let serial = 0;

export const makeHighlight = (): Atom<Flash | null> => atom<Flash | null>("found highlight", null);

export function flash(
  highlight: Atom<Flash | null>,
  found: { label: string; page: TLPageId; polygon: readonly Point[] },
): void {
  serial += 1;
  highlight.set({ ...found, serial });
}

// Two beats, then a hold and a fade.
const PULSE: Keyframe[] = [
  { opacity: 0 },
  { offset: 0.08, opacity: 1 },
  { offset: 0.2, opacity: 0.35 },
  { offset: 0.32, opacity: 1 },
  { offset: 0.8, opacity: 1 },
  { opacity: 0 },
];

// Draws the flash over the canvas, where this person's camera puts it, for
// as long as they are on its page. It lives in this browser only: nothing
// of it reaches the document or anyone else's screen.
export function FoundHighlight() {
  const editor = useEditor();
  const { copy, highlight } = useBoardUi();
  const drawing = useRef<SVGSVGElement>(null);
  const shown = useValue(
    "found highlight on screen",
    () => {
      const current = highlight.get();
      if (current === null || current.page !== editor.getCurrentPageId()) return null;
      const points = current.polygon.map((point) => editor.pageToViewport(point));
      return {
        label: current.label,
        points: points.map(({ x, y }) => `${x},${y}`).join(" "),
        serial: current.serial,
      };
    },
    [editor, highlight],
  );
  const current = shown?.serial;

  useEffect(() => {
    if (current === undefined) return;
    const timer = setTimeout(() => {
      if (highlight.get()?.serial === current) highlight.set(null);
    }, FLASH_MS);
    if (!globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawing.current?.animate(PULSE, { duration: FLASH_MS, easing: "ease-out", fill: "forwards" });
    }
    return () => clearTimeout(timer);
  }, [current, highlight]);

  if (shown === null) return null;
  return (
    <svg
      aria-label={fill(copy.searchFound, { text: shown.label })}
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      ref={drawing}
      role="img"
    >
      <polygon
        className="fill-primary/10 stroke-primary/30"
        points={shown.points}
        strokeLinejoin="round"
        strokeWidth={12}
      />
      <polygon
        className="fill-none stroke-primary"
        points={shown.points}
        strokeLinejoin="round"
        strokeWidth={3}
      />
    </svg>
  );
}
