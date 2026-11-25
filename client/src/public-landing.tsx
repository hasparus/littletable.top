import { useEditor, useValue } from "tldraw";

import type { LandingCopy } from "./front-copy";

import { PUBLIC_HANDOUT } from "../../src/public-board-demo-ids";
import { LANDING_DEMO_COPY } from "./front-copy";
import { publicDemoPage } from "./public-demo-page";

export type PublicLanding = { copy: LandingCopy };

/** The note is rendered in canvas coordinates, outside the shared document. */
export function PublicBoardIntro({ copy }: PublicLanding) {
  const editor = useEditor();
  const position = useValue(
    "public board introduction",
    () => {
      if (editor.getCurrentPageId() !== (publicDemoPage(editor) ?? editor.getPages()[0]?.id)) {
        return null;
      }
      const { x, y } = editor.pageToViewport({ x: 0, y: 0 });
      return {
        x,
        y,
        zoom: editor.getZoomLevel(),
      };
    },
    [editor],
  );
  if (position === null) return null;
  const { x, y, zoom } = position;
  return (
    <>
      <section
        aria-label={copy.publicBoard}
        className="pointer-events-none absolute origin-top-left"
        data-public-board-note
        style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
      >
        {copy.publicStory.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <footer>{copy.publicExpiry}</footer>
      </section>
      <PublicBoardDemo />
    </>
  );
}

function PublicBoardDemo() {
  const editor = useEditor();
  const position = useValue(
    "North Gate walkthrough",
    () => {
      if (publicDemoPage(editor) !== editor.getCurrentPageId()) return null;
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- tldraw’s canonical bounds method.
      const bounds = editor.getShapePageBounds(PUBLIC_HANDOUT);
      if (bounds === undefined) return null;
      const { x, y } = editor.pageToViewport({ x: bounds.x, y: bounds.y + bounds.h + 12 });
      return { x, y, width: bounds.w, zoom: editor.getZoomLevel() };
    },
    [editor],
  );
  if (position === null) return null;
  const { width, x, y, zoom } = position;
  return (
    <section
      aria-label="North Gate"
      className="pointer-events-none absolute top-0 left-0 origin-top-left"
      data-public-board-demo
      style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})`, width }}
    >
      {LANDING_DEMO_COPY.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}
