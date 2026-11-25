const EDGE_MS = 90;
const EDGE_ANGLE = 84;
const edgeTiming = {
  duration: EDGE_MS,
  easing: "cubic-bezier(.2,.55,.45,1)",
  fill: "forwards",
} as const;

export function turnHeldBack(paper: HTMLElement, started: number) {
  const turn = paper.animate(
    [
      { transform: "perspective(700px) rotateY(0deg)" },
      { transform: `perspective(700px) rotateY(-${EDGE_ANGLE}deg)` },
    ],
    edgeTiming,
  );
  turn.currentTime = Math.min(EDGE_MS, performance.now() - started);
  return turn;
}

async function highlight(canvas: HTMLCanvasElement, src: string, lifetime: AbortController) {
  if (!("gpu" in navigator) || lifetime.signal.aborted) return;
  try {
    const { playDeckReveal } = await import("./deck-reveal-gpu");
    if (!lifetime.signal.aborted) await playDeckReveal(canvas, src, lifetime.signal);
  } catch {
    lifetime.abort();
  }
}

export function revealDeckCard(
  paper: HTMLElement,
  canvas: HTMLCanvasElement,
  src: string,
  travelX: number,
  travelY: number,
  started?: number,
) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches) return;
  const side = travelX > 0 ? -1 : 1;
  const pose = (distance: number, angle: number) =>
    `translate(${distance * travelX}px, ${distance * travelY}px) perspective(700px) rotateY(${side * angle}deg)`;
  const edge = pose(0.45, 180 - EDGE_ANGLE);
  const lift = paper.animate([{ transform: pose(1, 180) }, { transform: edge }], edgeTiming);
  if (started !== undefined) lift.currentTime = Math.min(EDGE_MS, performance.now() - started);
  const image = new Image();
  image.src = src;
  const lifetime = new AbortController();
  let settle: Animation | undefined;
  const cancel = () => {
    lifetime.abort();
    lift.cancel();
    settle?.cancel();
    motion.removeEventListener("change", cancel);
  };
  motion.addEventListener("change", cancel);
  void Promise.all([image.decode(), lift.finished]).then(() => {
    if (lifetime.signal.aborted) return;
    settle = paper.animate([{ transform: edge }, { transform: pose(0, 0) }], {
      duration: 165,
      easing: "cubic-bezier(.16,.76,.24,1)",
    });
    lift.cancel();
    void highlight(canvas, src, lifetime);
  }, cancel);
  return cancel;
}
