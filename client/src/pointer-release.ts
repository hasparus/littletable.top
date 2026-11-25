const SAMPLE_MS = 80;
const TOSS_PX_PER_MS = 0.6;
const MIN_SAMPLE_MS = 16;

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

  function isToss(end: Sample) {
    record(end);
    if (samples.length < 2) return false;
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
    return Math.hypot(dx, dy) >= TOSS_PX_PER_MS * Math.max(MIN_SAMPLE_MS, elapsed);
  }

  return { move, isToss };
}
