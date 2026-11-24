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
  );
}
