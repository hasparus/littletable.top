import { useEffect } from "react";

export function useBoardViewport() {
  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const viewport = globalThis.visualViewport;
    let frame = 0;
    function restore() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (window.scrollX === 0 && window.scrollY === 0) return;
        if (
          (viewport && viewport.scale !== 1) ||
          document.activeElement?.matches(
            "input, textarea, select, [contenteditable]:not([contenteditable=false])",
          )
        )
          return;
        // WARNING: Safari can leave the document scrolled after panning to a focused field.
        window.scrollTo({ behavior: "instant", left: 0, top: 0 });
      });
    }
    const events = new AbortController();
    const options = { signal: events.signal };
    window.addEventListener("scroll", restore, options);
    viewport?.addEventListener("resize", restore, options);
    document.addEventListener("focusout", restore, options);
    return () => {
      events.abort();
      cancelAnimationFrame(frame);
    };
  }, []);
}
