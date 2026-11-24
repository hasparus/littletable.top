import { useEditor, useValue } from "tldraw";

import type { FrontCopy } from "./front-copy";

export type PublicLanding = { copy: FrontCopy };

// The note is rendered in canvas coordinates, outside the shared document.
export function PublicBoardIntro({ copy }: PublicLanding) {
  const editor = useEditor();
  const position = useValue(
    "public board introduction",
    () => {
      if (editor.getCurrentPageId() !== editor.getPages()[0]?.id) return null;
      const { x, y } = editor.pageToViewport({ x: 12, y: 68 });
      return {
        width: Math.min(502, Math.max(232, editor.getViewportScreenBounds().w - 24)),
        x,
        y,
        zoom: editor.getZoomLevel(),
      };
    },
    [editor],
  );
  if (position === null) return null;
  const { width, x, y, zoom } = position;
  return (
    <section
      aria-label={copy.publicBoard}
      className="pointer-events-none absolute top-0 left-0 origin-top-left"
      data-public-board-note
      style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})`, width }}
    >
      <h1>
        {copy.publicGreeting} <span data-public-board-wave>👋</span>
      </h1>
      {copy.publicStory.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <footer>{copy.publicReset}</footer>
    </section>
  );
}
