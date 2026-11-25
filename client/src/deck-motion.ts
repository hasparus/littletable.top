const TURN_MS = 255;

type TurnFlight = { duration: number; elapsed: number };

function flyingBackAngle(progress: number) {
  return 65 * Math.sin(Math.PI * progress ** 0.7);
}

export function turnFlyingBack(paper: HTMLElement, duration: number, elapsed: number) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches || elapsed >= duration || duration <= 0) return;
  const frames = Array.from({ length: 17 }, (_, i) => ({
    transform: `rotateY(${-flyingBackAngle(i / 16)}deg)`,
  }));
  const back = paper.animate(frames, { duration, id: "deck-flight-back" });
  back.currentTime = Math.max(0, elapsed);
  const cancel = () => back.cancel();
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void back.finished.then(cleanup, cleanup);
  return cancel;
}

function turnCard(
  paper: HTMLElement,
  sheen: HTMLElement | null,
  travelX: number,
  travelY: number,
  settled?: () => void,
  angle = 180,
  duration = TURN_MS,
) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches || duration <= 0) {
    settled?.();
    return;
  }
  const side = travelX > 0 ? -1 : 1;
  const pose = (distance: number, angle: number) =>
    `translate(${distance * travelX}px, ${distance * travelY}px) perspective(700px) rotateY(${side * angle}deg)`;
  const turn = paper.animate(
    [
      { transform: pose(1, angle), easing: "cubic-bezier(.19,.28,.62,.68)" },
      {
        transform: pose(0.45, (angle * 96) / 180),
        offset: 90 / TURN_MS,
        easing: "cubic-bezier(.25,.34,.50,1)",
      },
      { transform: pose(0, 0) },
    ],
    { duration, id: "deck-turn" },
  );
  const glint = sheen?.animate(
    [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1, offset: 0.67 }, { opacity: 0 }],
    { duration },
  );
  const cancel = () => {
    turn.cancel();
    glint?.cancel();
  };
  motion.addEventListener("change", cancel);
  const cleanup = () => {
    motion.removeEventListener("change", cancel);
    settled?.();
  };
  void turn.finished.then(cleanup, cleanup);
  return cancel;
}

export function revealDeckCard(
  paper: HTMLElement,
  front: HTMLElement,
  sheen: HTMLElement | null,
  face: string,
  recent: boolean,
  travelX: number,
  travelY: number,
  settled?: () => void,
  flight?: TurnFlight,
) {
  const url = new URL(face, document.baseURI).href;
  let decoding: HTMLImageElement | undefined;
  let frame = 0;
  let stopTurn: (() => void) | undefined;
  let cancelled = false;
  const released = performance.now() - (flight?.elapsed ?? 0);
  const stopBack =
    recent && flight ? turnFlyingBack(paper, flight.duration, flight.elapsed) : undefined;
  paper.dataset.deckWaiting = "";
  paper.style.setProperty("--deck-travel-x", `${recent ? travelX : 0}px`);
  paper.style.setProperty("--deck-travel-y", `${recent ? travelY : 0}px`);
  function onLoad() {
    const image = [...front.getElementsByTagName("img")].find(
      (img) => img.currentSrc === url && img.complete && img.naturalWidth > 0,
    );
    if (!image || image === decoding) return;
    decoding = image;
    void image.decode().then(
      () => {
        if (cancelled || decoding !== image) return;
        frame = requestAnimationFrame(() => {
          if (cancelled || image !== decoding || paper.dataset.deckWaiting === undefined) return;
          if (!front.contains(image) || image.currentSrc !== url) {
            decoding = undefined;
            onLoad();
            return;
          }
          delete paper.dataset.deckWaiting;
          stopBack?.();
          if (recent) {
            const elapsed = Math.max(0, performance.now() - released);
            const tilt = flight ? flyingBackAngle(Math.min(1, elapsed / flight.duration)) : 0;
            const remaining = flight ? Math.min(TURN_MS, flight.duration - elapsed) : TURN_MS;
            stopTurn = turnCard(paper, sheen, travelX, travelY, settled, 180 - tilt, remaining);
          }
          front.removeEventListener("load", onLoad, true);
        });
      },
      () => {
        if (decoding === image) decoding = undefined;
      },
    );
  }
  front.addEventListener("load", onLoad, true);
  onLoad();
  return () => {
    cancelled = true;
    front.removeEventListener("load", onLoad, true);
    cancelAnimationFrame(frame);
    stopBack?.();
    stopTurn?.();
  };
}
