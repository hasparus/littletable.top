import { T } from "@tldraw/validate";
import { useLayoutEffect, useRef } from "react";
import { type Editor, type "TLImageShape" as BoardImage, Vec } from "tldraw";

import { cardFlightDuration, cardFlightRotation } from "../../src/deck-records";
import { animateCardFlight, type CardFlight } from "./pointer-release";

const pending = new WeakMap<Editor, { id: BoardImage["id"]; toss: CardFlight; at: number }>();

const offset = T.number.check((value) => {
  if (!Number.isFinite(value) || Math.abs(value) > 32_768)
    throw new Error("Invalid glide distance");
});
const glide = T.object({
  at: T.integer,
  x: offset,
  y: offset,
  duration: cardFlightDuration,
  rotation: cardFlightRotation.optional(),
});

export function clearCardGlide(editor: Editor) {
  pending.delete(editor);
}

export function offerCardGlide(editor: Editor, id: BoardImage["id"], toss: CardFlight) {
  pending.set(editor, { id, toss, at: performance.now() });
}

export function takeCardGlide(editor: Editor, id: BoardImage["id"]) {
  const release = pending.get(editor);
  if (release?.id !== id) return;
  pending.delete(editor);
  if (performance.now() - release.at <= 250) return release.toss;
}

export function finishCardGlide(
  image: BoardImage,
  toss: CardFlight,
  zoom: number,
  parentRotation: number,
  pageRotation: number,
) {
  const travel = Vec.Div(toss, zoom);
  const parent = Vec.Rot(travel, -parentRotation);
  const rotation = image.rotation + toss.rotation;
  const half = new Vec(image.props.w / 2, image.props.h / 2);
  const centerOffset = Vec.Rot(half, image.rotation).sub(Vec.Rot(half, rotation));
  const origin = Vec.Rot(travel, -(pageRotation + toss.rotation)).mul(-1);
  return {
    id: image.id,
    type: image.type,
    x: image.x + parent.x + centerOffset.x,
    y: image.y + parent.y + centerOffset.y,
    rotation,
    meta: {
      ...image.meta,
      deckGlide: {
        at: Date.now(),
        x: origin.x,
        y: origin.y,
        duration: toss.duration,
        rotation: toss.rotation,
      },
    },
  };
}

export function useCardGlide(motion: BoardImage["meta"][string] | undefined) {
  const paper = useRef<HTMLDivElement>(null);
  const played = useRef<number[]>(glide.isValid(motion) ? [motion.at] : []);
  useLayoutEffect(() => {
    if (!paper.current || !glide.isValid(motion) || played.current.includes(motion.at)) return;
    played.current = [...played.current.slice(-15), motion.at];
    const elapsed = Math.max(0, Date.now() - motion.at);
    if (elapsed >= motion.duration) return;
    return animateCardFlight(paper.current, motion, motion.duration, elapsed);
  }, [motion]);
  return paper;
}
