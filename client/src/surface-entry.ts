export function enterSurface(surface: HTMLElement, trigger: Element | null) {
  if (!matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
  const anchor = trigger?.getBoundingClientRect();
  if (anchor && anchor.width > 0 && anchor.height > 0) {
    const bounds = surface.getBoundingClientRect();
    const x = Math.min(bounds.width, Math.max(0, anchor.left + anchor.width / 2 - bounds.left));
    const y = Math.min(bounds.height, Math.max(0, anchor.top + anchor.height / 2 - bounds.top));
    surface.style.transformOrigin = `${x}px ${y}px`;
  }
  surface.dataset.entering = "";
}
