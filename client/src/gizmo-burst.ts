const frames = Array.from({ length: 25 }, (_, index) => ({
  transform: `translate(${-(index % 5) * 20}%, ${-Math.floor(index / 5) * 20}%)`,
  easing: "steps(1, end)",
}));

export function playGizmoBurst(sprite: HTMLImageElement, button: HTMLElement, table: HTMLElement) {
  const layer = sprite.parentElement;
  if (!layer) return;
  const origin = button.getBoundingClientRect();
  const bounds = table.getBoundingClientRect();
  const x = origin.left + origin.width / 2 - bounds.left;
  const y = origin.top + origin.height / 2 - bounds.top;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const size = Math.min(origin.width * (motion.matches ? 1.3 : 3.4), bounds.width * 0.9, 480);
  layer.style.width = `${size}px`;
  layer.style.left = `${x - size / 2}px`;
  layer.style.top = `${y - size / 2}px`;
  const duration = motion.matches ? 210 : 640;
  const reel = sprite.animate(motion.matches ? [frames[4]!, frames[4]!] : frames, { duration });
  const exposure = layer.animate(
    [
      { visibility: "visible", opacity: 1 },
      { visibility: "visible", opacity: motion.matches ? 0 : 1 },
    ],
    { duration },
  );
  const stop = () => {
    reel.cancel();
    exposure.cancel();
  };
  motion.addEventListener("change", stop);
  const detach = () => motion.removeEventListener("change", stop);
  void exposure.finished.then(detach, detach);
  return stop;
}
