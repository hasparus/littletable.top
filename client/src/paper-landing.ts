import { springGizmo } from "./gizmo-feedback";
import { advancePhysicsFrame, DT, fallingSpeed, FPS, reboundSpeed } from "./table-physics";

export function droppedEdge(lift: number) {
  let height = lift;
  let speed = 0;
  const heights = [height];
  const step = () => {
    speed = fallingSpeed(speed);
    height += speed * DT;
    if (height <= 0) {
      height = 0;
      speed = reboundSpeed(speed);
    }
  };
  do {
    advancePhysicsFrame(step);
    heights.push(height);
  } while (height > 0 || speed > 0);
  return heights;
}

const RAISED_SCALE = 0.035;
export function paperLift(paper: HTMLElement | null) {
  if (!paper) return 0;
  const { transform } = getComputedStyle(paper);
  if (!transform || transform === "none") return 0;
  const { a, b } = new DOMMatrixReadOnly(transform);
  return Math.max(0, (Math.hypot(a, b) - 1) / RAISED_SCALE);
}
const pose = (tilt: number, lift: number) =>
  `rotate(${tilt * lift}deg) scale(${1 + lift * RAISED_SCALE})`;

export function liftPaper(paper: HTMLElement, tilt: number) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches) return;
  paper.style.transform = pose(tilt, 1);
  const cancelSpring = springGizmo(paper, (displacement) => pose(tilt, 1 - displacement));
  const clear = () => {
    cancelSpring();
    paper.style.transform = "";
    motion.removeEventListener("change", clear);
  };
  motion.addEventListener("change", clear);
  return clear;
}

export function landPaper(
  paper: HTMLElement,
  tilt: number,
  lift: number,
  started = performance.now(),
) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const elapsed = performance.now() - started;
  if (motion.matches || lift <= 0) return;
  const heights = droppedEdge(lift);
  const duration = ((heights.length - 1) * 1000) / FPS;
  if (elapsed >= duration) return;
  const fall = paper.animate(
    heights.map((height) => ({ transform: pose(tilt, height) })),
    {
      duration,
      id: "deck-paper-landing",
    },
  );
  fall.currentTime = elapsed;
  const cancel = () => fall.cancel();
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void fall.finished.then(cleanup, cleanup);
  return cancel;
}
