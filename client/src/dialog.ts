import { type RefObject, useEffect } from "react";

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
