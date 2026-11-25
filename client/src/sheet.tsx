import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
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

type KeyboardArea = { bottom: number; height: number; top: number };
type SheetStyle = CSSProperties & Partial<Record<`--${"chat" | "sheet"}-${string}`, string>>;

const pixels = (value: number | undefined) => (value === undefined ? undefined : `${value}px`);

// WARNING: The on-screen keyboard can cover the layout viewport without resizing it. Position the sheet using the visual viewport.
function useAboveKeyboard() {
  const [area, setArea] = useState<KeyboardArea>();
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
              top: viewport.offsetTop + GAP_PX,
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

function sheetStyle(
  size: ChatSize | undefined,
  keyboardArea: KeyboardArea | undefined,
): SheetStyle {
  const { height, width, left, bottom } = size ?? {};
  const keyboardHeight = pixels(keyboardArea?.height);
  return {
    "--sheet-keyboard-bottom": pixels(keyboardArea?.bottom),
    "--sheet-keyboard-height": keyboardHeight,
    "--sheet-keyboard-top": pixels(keyboardArea?.top),
    maxHeight: keyboardHeight,
    "--chat-height": pixels(height),
    "--chat-left": pixels(left),
    "--chat-bottom": pixels(bottom),
    "--chat-width": pixels(width),
  };
}

function useSheetFocus(sheet: RefObject<HTMLElement | null>, panel: Panel) {
  useLayoutEffect(() => {
    const surface = sheet.current;
    if (!surface) return;
    const trigger = surface
      .closest("[data-board-shell]")
      ?.querySelector(`[aria-controls="${PANEL_ID[panel]}"]`);
    enterSurface(surface, trigger ?? null);
  }, [panel, sheet]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = sheet.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? sheet.current?.querySelector<HTMLElement>("h2") ?? sheet.current)?.focus({
      preventScroll: true,
    });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [sheet]);
}

function useSheetEscape(
  sheet: RefObject<HTMLElement | null>,
  close: () => void,
  onEscape: ((event: KeyboardEvent) => void) | undefined,
) {
  useEffect(() => {
    const target: EventTarget | null = onEscape === undefined ? document : sheet.current;
    const dismiss = (event: Event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog:modal")
      )
        return;
      if (onEscape === undefined) {
        close();
        return;
      }
      // WARNING: The editor handles Escape on its container, above the sheet.
      event.preventDefault();
      event.stopPropagation();
      onEscape(event);
    };
    target?.addEventListener("keydown", dismiss);
    return () => target?.removeEventListener("keydown", dismiss);
  }, [sheet, close, onEscape]);
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
  onEscape,
  panel,
  title,
}: {
  chatResize?: { change: (size: ChatSize) => void; size: ChatSize };
  children: ReactNode;
  field?: ReactNode;
  onEscape?: (event: KeyboardEvent) => void;
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
  const isSearch = panel === "search";
  const style = sheetStyle(chatResize?.size, keyboardArea);

  useSheetFocus(sheet, panel);
  useSheetEscape(sheet, () => open(null), onEscape);

  return (
    <>
      {!isSearch && (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 top-0 bottom-[max(var(--board-sheet-bottom),calc(max(4px,env(safe-area-inset-bottom))+52px))] z-40 bg-ink/20 sm:hidden"
          data-sheet-scrim
          onClick={() => open(null)}
        />
      )}
      <section
        aria-label={hasField ? title : undefined}
        aria-labelledby={hasField ? undefined : heading}
        className={`${BOARD_DIALOG} z-50 flex flex-col ${isChat ? "" : "sm:w-88"} ${hasField ? "gap-2 p-2" : ""}`}
        data-chat-size={
          isChat ? (chatResize?.size.height === undefined ? "natural" : "fixed") : undefined
        }
        id={PANEL_ID[panel]}
        ref={sheet}
        role="dialog"
        style={style}
        tabIndex={-1}
      >
        {chatResize && <ChatResize sheet={sheet} {...chatResize} />}
        <header
          className={`${BOARD_DIALOG_HEADER} ${hasField ? "shrink-0" : "py-1 pr-1 pl-4"} ${isChat ? "shrink-0 border-b border-border" : ""}`}
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
