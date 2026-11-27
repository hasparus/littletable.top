import { type RefObject, useEffect } from "react";

export const BOARD_DIALOG =
  "fixed right-(--board-toolbar-right) [&_button:enabled]:cursor-pointer left-(--board-left) bottom-(--sheet-keyboard-bottom,var(--board-sheet-bottom)) max-h-[min(70dvh,36rem)] rounded-2xl bg-bg-secondary text-foreground shadow-sheet ring-1 ring-border outline-none sm:right-auto sm:bottom-(--sheet-keyboard-bottom,5rem) sm:left-1/2 sm:max-h-[calc(100dvh-7rem)] sm:-translate-x-1/2";
export const BOARD_DIALOG_HEADER = "flex items-center gap-2";
export const BOARD_DIALOG_TITLE = "flex-1 text-lg font-semibold outline-none";
export const BOARD_DIALOG_CLOSE =
  "grid size-11 place-items-center rounded-full text-foreground-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus";

export function useDialogBackdrop(dialog: RefObject<HTMLDialogElement | null>, enabled = true) {
  useEffect(() => {
    const element = dialog.current;
    if (element === null || !enabled) return;
    const events = new AbortController();
    let pressedBackdrop = false;
    element.addEventListener(
      "pointerdown",
      (event) => {
        pressedBackdrop = hitBackdrop(element, event);
      },
      { signal: events.signal },
    );
    element.addEventListener(
      "click",
      (event) => {
        if (pressedBackdrop && hitBackdrop(element, event)) element.close();
        pressedBackdrop = false;
      },
      { signal: events.signal },
    );
    return () => events.abort();
  }, [dialog, enabled]);
}

function hitBackdrop(dialog: HTMLDialogElement, event: MouseEvent) {
  if (event.target !== dialog) return false;
  const { bottom, left, right, top } = dialog.getBoundingClientRect();
  const { clientX, clientY } = event;
  return clientX < left || clientX >= right || clientY < top || clientY >= bottom;
}
