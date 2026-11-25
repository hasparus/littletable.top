import { useRef } from "react";
import { useEditor, useValue } from "tldraw";

import type { FrontCopy } from "./front-copy";

import { PUBLIC_DEMO_SHAPE } from "../../src/public-board-demo-ids";
import { goToBounds } from "./places";

export type PublicLanding = { copy: FrontCopy };

// The note is rendered in canvas coordinates, outside the shared document.
export function PublicBoardIntro({ copy }: PublicLanding) {
  const editor = useEditor();
  const featuresRef = useRef<HTMLDivElement>(null);
  const position = useValue(
    "public board introduction",
    () => {
      const demo = editor.getShape(PUBLIC_DEMO_SHAPE);
      const image = demo?.type === "image" ? demo : undefined;
      if (editor.getCurrentPageId() !== (image?.parentId ?? editor.getPages()[0]?.id)) return null;
      const { x, y } = editor.pageToViewport({
        x: 0,
        y: image === undefined ? 0 : image.y + image.props.h + 12,
      });
      return {
        hasDemo: image !== undefined,
        x,
        y,
        zoom: editor.getZoomLevel(),
      };
    },
    [editor],
  );
  if (position === null) return null;
  const { hasDemo, x, y, zoom } = position;
  return (
    <section
      aria-label={copy.publicBoard}
      className="pointer-events-none absolute origin-top-left"
      data-public-board-note
      style={{
        top: hasDemo ? 0 : undefined,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
      }}
    >
      <button
        className="pointer-events-auto mb-2 inline-flex min-h-11 cursor-pointer items-center gap-2 underline-offset-4 hover:underline focus-visible:underline"
        onClick={() => {
          const features = featuresRef.current;
          if (features === null) return;
          const rect = features.getBoundingClientRect();
          const { x, y } = editor.screenToPage({ x: rect.left, y: rect.top });
          const zoom = editor.getZoomLevel();
          goToBounds(editor, editor.getCurrentPageId(), {
            h: rect.height / zoom,
            w: rect.width / zoom,
            x,
            y,
          });
          features.focus({ preventScroll: true });
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {copy.publicSeeFeatures}
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 28 24"
          width="28"
        >
          <path d="M3 4c13-2 18 5 17 15m-5-5 5 5 5-5" />
        </svg>
      </button>
      <div className="mb-4" ref={featuresRef} tabIndex={-1}>
        {hasDemo && (
          <>
            <p>{copy.publicDemo}</p>
            <p>{copy.publicRoll}</p>
          </>
        )}
        <p>{copy.publicDraw}</p>
        <p>{copy.publicMakeBoard}</p>
      </div>
      {copy.publicStory.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <footer>{copy.publicExpiry}</footer>
    </section>
  );
}
