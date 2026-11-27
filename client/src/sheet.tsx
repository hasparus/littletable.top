import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ChatResize, type ChatSize, useChatMove } from "./chat-resize";
import {
  BOARD_DIALOG,
  BOARD_DIALOG_CLOSE,
  BOARD_DIALOG_HEADER,
  BOARD_DIALOG_TITLE,
} from "./dialog";
import { Icon } from "./icons";
import { enterSurface } from "./surface-entry";
import { type Panel, PANEL_ID, useBoardUi } from "./ui";

// WARNING: Small visual viewport changes can be browser chrome rather than an on-screen keyboard.
const KEYBOARD_MIN_PX = 120;
const GAP_PX = 8;

type SheetStyle = CSSProperties & Partial<Record<`--${"chat" | "sheet"}-${string}`, string>>;

const pixels = (value: number | undefined) => (value === undefined ? undefined : `${value}px`);

// WARNING: The on-screen keyboard can cover the layout viewport without resizing it. Position the sheet using the visual viewport.
function useAboveKeyboard() {
  const [area, setArea] = useState<{ bottom: number; height: number }>();
  useEffect(() => {
    const viewport = globalThis.visualViewport;
    if (viewport === null || viewport === undefined) return;
    const measure = () => {
      const covered = globalThis.innerHeight - viewport.height;
      setArea(
        covered < KEYBOARD_MIN_PX || viewport.scale !== 1
          ? undefined
          : {
              bottom: Math.max(0, covered - viewport.offsetTop) + GAP_PX,
              height: viewport.height - 2 * GAP_PX,
            },
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
  return area;
}

/**
 * One panel at a time, floating just above the toolbar it came from. The
 * bar stays in view, so on a phone the three controls switch between their
 * sheets like tabs; on a wider screen tldraw's menus keep the corners.
 * A sheet with a `field` shows it where the title would be, and keeps the
 * title as its name.
 */
export function Sheet({
  chatResize,
  children,
  field,
  panel,
  title,
}: {
  chatResize?: { change: (size: ChatSize) => void; size: ChatSize };
  children: ReactNode;
  field?: ReactNode;
  panel: Panel;
  title: string;
}) {
  const { copy, open } = useBoardUi();
  const heading = useId();
  const sheet = useRef<HTMLElement>(null);
  const keyboardArea = useAboveKeyboard();
  const move = useChatMove(sheet, chatResize, keyboardArea);
  const hasField = field !== undefined;
  const isChat = panel === "chat";
  const { height, width, left, bottom } = chatResize?.size ?? {};
  const keyboardHeight = pixels(keyboardArea?.height);
  const style: SheetStyle = {
    "--sheet-keyboard-bottom": pixels(keyboardArea?.bottom),
    "--sheet-keyboard-height": keyboardHeight,
    maxHeight: keyboardHeight,
    "--chat-height": pixels(height),
    "--chat-left": pixels(left),
    "--chat-bottom": pixels(bottom),
    "--chat-width": pixels(width),
  };

  useLayoutEffect(() => {
    const surface = sheet.current;
    if (!surface) return;
    const trigger = surface
      .closest("[data-board-layout]")
      ?.querySelector(`[aria-controls="${PANEL_ID[panel]}"]`);
    enterSurface(surface, trigger ?? null);
  }, [panel]);

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

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog:modal")
      )
        open(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-x-0 top-0 bottom-[max(var(--board-sheet-bottom),calc(max(4px,env(safe-area-inset-bottom))+52px))] z-40 bg-ink/20 sm:hidden"
        data-sheet-scrim
        onClick={() => open(null)}
      />
      <section
        aria-label={hasField ? title : undefined}
        aria-labelledby={hasField ? undefined : heading}
        className={`${BOARD_DIALOG} z-50 flex flex-col ${isChat ? "" : "sm:w-88"} ${hasField ? "gap-2 p-2" : ""}`}
        data-chat-size={isChat ? (height === undefined ? "natural" : "fixed") : undefined}
        id={PANEL_ID[panel]}
        ref={sheet}
        role="dialog"
        style={style}
        tabIndex={-1}
      >
        {chatResize && <ChatResize sheet={sheet} {...chatResize} />}
        <header
          className={`${BOARD_DIALOG_HEADER} ${hasField ? "" : "py-1 pr-1 pl-4"} ${isChat ? "shrink-0 border-b border-border" : ""}`}
        >
          {field ?? (
            <h2 className={BOARD_DIALOG_TITLE} id={heading} tabIndex={-1} {...move}>
              {title}
            </h2>
          )}
          <button
            aria-label={copy.close}
            className={BOARD_DIALOG_CLOSE}
            onClick={() => open(null)}
            type="button"
          >
            <Icon name="Close" />
          </button>
        </header>
        <div
          className={
            isChat
              ? "flex min-h-0 flex-1 flex-col"
              : `min-h-0 flex-1 overflow-y-auto overscroll-contain ${hasField ? "" : "px-4 pb-4"}`
          }
        >
          {children}
        </div>
      </section>
    </>
  );
}
