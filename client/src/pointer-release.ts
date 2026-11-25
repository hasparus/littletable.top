import { FPS } from "./table-physics";

const SAMPLE_MS = 80;
const TOSS_PX_PER_MS = 0.6;
const MIN_SAMPLE_MS = 16;

const GRAVITY_PX_PER_MS2 = 0.006;
const CONTACT_DECELERATION_PX_PER_MS2 = 0.0046;
const LIFT_TO_FORWARD_SPEED = 0.25;
const MAX_LAUNCH_PX_PER_MS = 0.8;
const RELEASE_TRANSFER = 0.6;
const CAMERA_DISTANCE_PX = 220;
const AIR_TIME_PER_SPEED = (2 * LIFT_TO_FORWARD_SPEED) / GRAVITY_PX_PER_MS2;
const SLIDE_TIME_PER_SPEED = 2 / CONTACT_DECELERATION_PX_PER_MS2;
const STOP_TIME_PER_SPEED = AIR_TIME_PER_SPEED + SLIDE_TIME_PER_SPEED;

type Offset = { x: number; y: number };
export type CardFlight = Offset & { duration: number };

/** Integrate the slide velocity, which falls with the square of the remaining time. */
export function cardTravel(speed: number, time: number) {
  const airTime = AIR_TIME_PER_SPEED * speed;
  if (time <= airTime || speed === 0) return speed * time;

  const slideTime = SLIDE_TIME_PER_SPEED * speed;
  const remaining = Math.max(0, 1 - (time - airTime) / slideTime);
  return speed * airTime + (speed * slideTime * (1 - remaining ** 3)) / 3;
}

/** Animate from the release offset to the stored resting position. The card flies at its launch
 * velocity until contact, then kinetic friction slows it to rest. */
export function animateCardFlight(
  element: HTMLElement,
  offset: Offset,
  duration: number,
  elapsed = 0,
) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches || duration <= 0 || elapsed >= duration) return;
  const speed = duration / STOP_TIME_PER_SPEED;
  const airTime = speed * AIR_TIME_PER_SPEED;
  const distance = cardTravel(speed, duration);
  const pose = (t: number) => {
    const remaining = 1 - cardTravel(speed, t) / distance;
    const height = (GRAVITY_PX_PER_MS2 * t * Math.max(0, airTime - t)) / 2;
    return {
      offset: t / duration,
      translate: `${offset.x * remaining}px ${offset.y * remaining}px`,
      scale: String(1 + height / CAMERA_DISTANCE_PX),
    };
  };
  const frames = [pose(0)];
  for (let time = 1000 / FPS; time < duration; time += 1000 / FPS) frames.push(pose(time));
  frames.push(pose(airTime), pose(duration));
  const flight = element.animate(
    frames.sort((a, b) => a.offset - b.offset),
    { duration, id: "deck-flight" },
  );
  flight.currentTime = Math.max(0, elapsed);
  const cancel = () => flight.cancel();
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void flight.finished.then(cleanup, cleanup);
  return cancel;
}

type Sample = Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">;
type Movement = Sample & { getCoalescedEvents?: () => Sample[] };

/** Measure hand speed in screen pixels over the final 80 ms, including time spent holding still. */
export function trackRelease(start: Sample) {
  const samples: Sample[] = [];
  function record({ clientX, clientY, timeStamp }: Sample) {
    const last = samples.at(-1);
    if (last && timeStamp < last.timeStamp) return;
    if (last?.timeStamp === timeStamp) samples.pop();
    samples.push({ clientX, clientY, timeStamp });
    while (samples.length > 2 && samples[1]!.timeStamp <= timeStamp - SAMPLE_MS) samples.shift();
  }
  record(start);

  function move(event: Movement) {
    for (const sample of event.getCoalescedEvents?.() ?? []) record(sample);
    record(event);
  }

  function throwAt(end: Sample) {
    record(end);
    if (samples.length < 2) return null;
    const first = samples[0]!;
    const second = samples[1]!;
    const gap = second.timeStamp - first.timeStamp;
    const burstAfterHold = gap > SAMPLE_MS && second.timeStamp < end.timeStamp;
    const from = burstAfterHold
      ? second.timeStamp
      : Math.max(first.timeStamp, end.timeStamp - SAMPLE_MS);
    const elapsed = end.timeStamp - from;
    const fraction = (from - first.timeStamp) / gap;
    const dx = end.clientX - first.clientX - fraction * (second.clientX - first.clientX);
    const dy = end.clientY - first.clientY - fraction * (second.clientY - first.clientY);
    const displacement = Math.hypot(dx, dy);
    const handSpeed = displacement / Math.max(MIN_SAMPLE_MS, elapsed);
    if (handSpeed < TOSS_PX_PER_MS) return null;
    const speed = Math.min(MAX_LAUNCH_PX_PER_MS, RELEASE_TRANSFER * handSpeed);
    const duration = STOP_TIME_PER_SPEED * speed;
    const reach = cardTravel(speed, duration) / displacement;
    return { x: dx * reach, y: dy * reach, duration } satisfies CardFlight;
  }

  return { move, throwAt };
}
