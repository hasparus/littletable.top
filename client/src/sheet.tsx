import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Icon } from "./icons";
import { type Panel, PANEL_ID, useBoardUi } from "./ui";

// Less than this hidden at the bottom of the screen is a browser's own bar
// coming and going, not an on-screen keyboard.
const KEYBOARD_MIN_PX = 120;
const GAP_PX = 8;

// An on-screen keyboard covers the bottom of the layout viewport, where the
// sheets sit, without resizing it (iOS, and Android by default); the visual
// viewport is what is left above it. While a keyboard is up, the sheet
// stands on it instead.
function useAboveKeyboard(): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const measure = () => {
      const hidden = globalThis.innerHeight - viewport.height - viewport.offsetTop;
      setStyle(
        hidden < KEYBOARD_MIN_PX
          ? undefined
          : { bottom: hidden + GAP_PX, maxHeight: viewport.height - 2 * GAP_PX },
      );
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);
  return style;
}

// One panel at a time, floating just above the toolbar it came from. The
// bar stays in view, so on a phone the three controls switch between their
// sheets like tabs; on a wider screen tldraw's menus keep the corners.
// A sheet with a `field` shows it where the title would be, and keeps the
// title as its name.
export function Sheet({
  children,
  field,
  panel,
  title,
}: {
  children: ReactNode;
  field?: ReactNode;
  panel: Panel;
  title: string;
}) {
  const { copy, open } = useBoardUi();
  const heading = useId();
  const sheet = useRef<HTMLElement>(null);
  const aboveKeyboard = useAboveKeyboard();

  // Focus moves in, and goes back to whatever opened the sheet.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = sheet.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? sheet.current?.querySelector<HTMLElement>("h2") ?? sheet.current)?.focus({
      preventScroll: true,
    });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // Escape closes the sheet wherever focus is, even on the canvas.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) open(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-x-0 top-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-40 bg-ink/20 sm:hidden"
        onClick={() => open(null)}
      />
      <section
        aria-label={field === undefined ? undefined : title}
        aria-labelledby={field === undefined ? heading : undefined}
        className="fixed inset-x-2 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-50 flex max-h-[min(70dvh,36rem)] flex-col rounded-2xl bg-bg-secondary text-foreground shadow-[0_8px_32px_rgb(37_34_32/0.22)] ring-1 ring-border outline-none sm:inset-x-auto sm:bottom-20 sm:left-1/2 sm:max-h-[calc(100dvh-7rem)] sm:w-88 sm:-translate-x-1/2"
        id={PANEL_ID[panel]}
        ref={sheet}
        role="dialog"
        style={aboveKeyboard}
        tabIndex={-1}
      >
        <header
          className={`flex items-center gap-2 py-1 pr-1 ${field === undefined ? "pl-4" : "pl-2"}`}
        >
          {field ?? (
            <h2 className="flex-1 text-lg font-semibold outline-none" id={heading} tabIndex={-1}>
              {title}
            </h2>
          )}
          <button
            aria-label={copy.close}
            className="grid size-11 place-items-center rounded-full text-foreground-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus"
            onClick={() => open(null)}
            type="button"
          >
            <Icon name="Close" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {children}
        </div>
      </section>
    </>
  );
}
