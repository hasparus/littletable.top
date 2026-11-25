import { useLayoutEffect } from "react";
import { type Editor, useEditor, useToasts, useValue } from "tldraw";

import type { LandingCopy } from "./front-copy";

import { PUBLIC_SIGNATURE_GROUP } from "../../src/public-signature";
import { useBoardUi } from "./ui";

export type PublicLanding = { copy: LandingCopy };

const signaturePage = (editor: Editor) => editor.store.get(PUBLIC_SIGNATURE_GROUP)?.parentId;

function guardLandingPageDeletion(editor: Editor, blocked: () => void) {
  const landingPage = signaturePage(editor);
  if (landingPage === undefined) return;
  // WARNING: The native page menu calls deletePage directly, which removes drawings before the page.
  const { deletePage } = editor;
  editor.deletePage = (page) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- tldraw's deletePage accepts an ID or a page record.
    const id = typeof page === "string" ? page : page.id;
    if (id === landingPage) {
      blocked();
      return editor;
    }
    return deletePage.call(editor, page);
  };
  return () => {
    editor.deletePage = deletePage;
  };
}

export function PublicPageDeleteGuard() {
  const editor = useEditor();
  const { addToast } = useToasts();
  const { copy } = useBoardUi();
  useLayoutEffect(
    () =>
      guardLandingPageDeletion(editor, () => {
        addToast({ severity: "info", title: copy.landingPageProtected });
      }),
    [addToast, copy.landingPageProtected, editor],
  );
  return null;
}

/** The note is rendered in canvas coordinates, outside the shared document. */
export function PublicBoardIntro({ copy }: PublicLanding) {
  const editor = useEditor();
  const position = useValue(
    "public board introduction",
    () => {
      const landingPage = signaturePage(editor) ?? editor.getPages()[0]?.id;
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
