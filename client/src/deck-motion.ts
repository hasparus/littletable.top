const TURN_MS = 255;

function turnCard(paper: HTMLElement, sheen: HTMLElement, travelX: number, travelY: number) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches) return;
  const side = travelX > 0 ? -1 : 1;
  const pose = (distance: number, angle: number) =>
    `translate(${distance * travelX}px, ${distance * travelY}px) perspective(700px) rotateY(${side * angle}deg)`;
  const turn = paper.animate(
    [
      { transform: pose(1, 180), easing: "cubic-bezier(.19,.28,.62,.68)" },
      { transform: pose(0.45, 96), offset: 90 / TURN_MS, easing: "cubic-bezier(.25,.34,.50,1)" },
      { transform: pose(0, 0) },
    ],
    { duration: TURN_MS, id: "deck-turn" },
  );
  const glint = sheen.animate(
    [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1, offset: 0.67 }, { opacity: 0 }],
    { duration: TURN_MS },
  );
  const cancel = () => {
    turn.cancel();
    glint.cancel();
  };
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void turn.finished.then(cleanup, cleanup);
  return cancel;
}

export function revealDeckCard(
  paper: HTMLElement,
  front: HTMLElement,
  sheen: HTMLElement,
  face: string,
  recent: boolean,
  travelX: number,
  travelY: number,
) {
  const url = new URL(face, document.baseURI).href;
  let decoding: HTMLImageElement | undefined;
  let frame = 0;
  let stopTurn: (() => void) | undefined;
  let cancelled = false;
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
          if (!front.contains(image) || image.currentSrc !== url) {
            decoding = undefined;
            onLoad();
            return;
          }
          delete paper.dataset.deckWaiting;
          if (recent) stopTurn = turnCard(paper, sheen, travelX, travelY);
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
    stopTurn?.();
  };
}
