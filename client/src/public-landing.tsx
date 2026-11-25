import { useEditor, useValue } from "tldraw";

import type { LandingCopy } from "./front-copy";

import { PUBLIC_SIGNATURE_GROUP } from "../../src/public-signature";

export type PublicLanding = { copy: LandingCopy };

/** The note is rendered in canvas coordinates, outside the shared document. */
export function PublicBoardIntro({ copy }: PublicLanding) {
  const editor = useEditor();
  const position = useValue(
    "public board introduction",
    () => {
      const landingPage =
        editor.store.get(PUBLIC_SIGNATURE_GROUP)?.parentId ?? editor.getPages()[0]?.id;
      if (editor.getCurrentPageId() !== landingPage) return null;
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
      className="pointer-events-none absolute top-0 left-0 origin-top-left"
      data-public-board-note
      style={{
        transform: `translate(${x}px, ${y}px) scale(${zoom}) translate(calc(var(--landing-left) * 1px), calc(var(--landing-top) * 1px))`,
      }}
    >
      {copy.publicStory.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <footer>{copy.publicExpiry}</footer>
    </section>
  );
}
