const EDGE_MS = 90;
const EDGE_ANGLE = 84;
const TURN_MS = 255;
const edgeTiming = {
  duration: EDGE_MS,
  easing: "cubic-bezier(.19,.28,.62,.68)",
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

export function revealDeckCard(
  paper: HTMLElement,
  sheen: HTMLElement,
  travelX: number,
  travelY: number,
  started?: number,
) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches) return;
  const side = travelX > 0 ? -1 : 1;
  const pose = (distance: number, angle: number) =>
    `translate(${distance * travelX}px, ${distance * travelY}px) perspective(700px) rotateY(${side * angle}deg)`;
  const turn = paper.animate(
    [
      { transform: pose(1, 180), easing: edgeTiming.easing },
      {
        transform: pose(0.45, 180 - EDGE_ANGLE),
        offset: EDGE_MS / TURN_MS,
        easing: "cubic-bezier(.25,.34,.50,1)",
      },
      { transform: pose(0, 0) },
    ],
    { duration: TURN_MS, id: "deck-turn" },
  );
  const glint = sheen.animate(
    [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1, offset: 0.67 }, { opacity: 0 }],
    { duration: TURN_MS },
  );
  if (started !== undefined) {
    const elapsed = Math.min(EDGE_MS, performance.now() - started);
    turn.currentTime = elapsed;
    glint.currentTime = elapsed;
  }
  const cancel = () => {
    turn.cancel();
    glint.cancel();
  };
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void turn.finished.then(cleanup, cleanup);
  return cancel;
}
