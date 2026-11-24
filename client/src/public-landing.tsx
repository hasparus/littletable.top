import { DefaultBackground, useEditor, useValue } from "tldraw";

import type { FrontCopy } from "./front-copy";

export type PublicLanding = { copy: FrontCopy; name: string };

// This lives in canvas coordinates, outside the room's editable records.
export function PublicBoardIntro({ copy, name }: PublicLanding) {
  const editor = useEditor();
  const position = useValue(
    "public board introduction",
    () => {
      if (editor.getCurrentPageId() !== editor.getPages()[0]?.id) return null;
      const { x, y } = editor.pageToViewport({ x: 16, y: 96 });
      return { x, y, zoom: editor.getZoomLevel() };
    },
    [editor],
  );
  return (
    <>
      <DefaultBackground />
      {position !== null && (
        <section
          aria-label={copy.publicBoard}
          className="pointer-events-none absolute top-0 left-0 w-[288px] origin-top-left rounded-2xl border border-border bg-bg-secondary p-5 text-foreground shadow-md"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${position.zoom})`,
          }}
        >
          <p className="text-sm font-medium text-foreground-muted">{copy.publicBoard}</p>
          <h1 className="mt-1 text-3xl leading-tight font-semibold">{name}</h1>
          <p className="mt-3 text-base leading-snug">{copy.publicDescription}</p>
          <p className="mt-3 text-sm leading-snug text-foreground-secondary">
            {copy.publicInvitation}
          </p>
        </section>
      )}
    </>
  );
}
