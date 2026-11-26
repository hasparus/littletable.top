const TURN_MS = 255;

type TurnFlight = { duration: number; elapsed: number };

const EDGE_ANGLE = 78;

function timeToEdge(duration: number) {
  return Math.min(TURN_MS * (EDGE_ANGLE / 180), duration * 0.45);
}

function flyingBackAngle(elapsed: number, duration: number) {
  return EDGE_ANGLE * Math.min(1, Math.max(0, elapsed) / timeToEdge(duration));
}

export function turnFlyingBack(paper: HTMLElement, duration: number, elapsed: number) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches || duration <= 0) return;
  const back = paper.animate(
    [{ transform: "rotateY(0deg)" }, { transform: `rotateY(${-EDGE_ANGLE}deg)` }],
    { duration: timeToEdge(duration), fill: "forwards", id: "deck-flight-back" },
  );
  back.currentTime = Math.max(0, elapsed);
  const cancel = () => {
    motion.removeEventListener("change", cancel);
    back.cancel();
  };
  motion.addEventListener("change", cancel);
  return cancel;
}

function turnCard(
  paper: HTMLElement,
  sheen: HTMLElement | null,
  travelX: number,
  travelY: number,
  settled?: () => void,
  startAngle = 180,
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
      { transform: pose(1, startAngle), easing: "cubic-bezier(.19,.28,.62,.68)" },
      {
        transform: pose(0.45, (startAngle * 96) / 180),
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

export function loadedDeckArt(front: HTMLElement, face: string) {
  const url = new URL(face, document.baseURI).href;
  return [...front.getElementsByTagName("img")].find(
    (image) => (image.currentSrc || image.src) === url && image.complete && image.naturalWidth > 0,
  );
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
  let decoding: HTMLImageElement | undefined;
  let stopTurn: (() => void) | undefined;
  let cancelled = false;
  const released = performance.now() - (flight?.elapsed ?? 0);
  const stopBack =
    recent && flight ? turnFlyingBack(paper, flight.duration, flight.elapsed) : undefined;
  paper.dataset.deckWaiting = "";
  paper.style.setProperty("--deck-travel-x", `${recent ? travelX : 0}px`);
  paper.style.setProperty("--deck-travel-y", `${recent ? travelY : 0}px`);
  function onLoad() {
    const image = loadedDeckArt(front, face);
    if (!image || image === decoding) return;
    decoding = image;
    const showReady = () => {
      if (cancelled || image !== decoding || paper.dataset.deckWaiting === undefined) return;
      if (loadedDeckArt(front, face) !== image) {
        decoding = undefined;
        onLoad();
        return;
      }
      delete paper.dataset.deckWaiting;
      stopBack?.();
      if (recent) {
        const elapsed = performance.now() - released;
        const tilt = flight ? flyingBackAngle(elapsed, flight.duration) : 0;
        const angle = 180 - tilt;
        paper.dataset.deckTurning = "";
        stopTurn = turnCard(
          paper,
          sheen,
          travelX,
          travelY,
          () => {
            if (cancelled) return;
            delete paper.dataset.deckTurning;
            settled?.();
          },
          angle,
          TURN_MS * (angle / 180),
        );
      }
      front.removeEventListener("load", onLoad, true);
    };
    void image.decode().then(showReady, showReady);
  }
  front.addEventListener("load", onLoad, true);
  onLoad();
  return () => {
    cancelled = true;
    delete paper.dataset.deckTurning;
    front.removeEventListener("load", onLoad, true);
    stopBack?.();
    stopTurn?.();
  };
}
