import { play, setEnabled, type SoundName } from "cuelume";

const SOUND_KEY = "little-table:gizmo-sounds";
let enabledInMemory = true;

export function gizmoSoundsEnabled() {
  try {
    const saved = localStorage.getItem(SOUND_KEY);
    if (saved !== null) return saved === "on";
  } catch {
    // WARNING: Browsers may disable storage, so keep the current tab's preference in memory.
  }
  return enabledInMemory;
}

export function setGizmoSoundsEnabled(enabled: boolean) {
  enabledInMemory = enabled;
  setEnabled(enabled);
  try {
    localStorage.setItem(SOUND_KEY, enabled ? "on" : "off");
  } catch {
    // WARNING: Sound controls still need to work when localStorage writes are unavailable.
  }
}

const cues = {
  impact: { sound: "tap", volume: 0.55 },
  pickup: { sound: "open", volume: 0.29 },
  place: { sound: "select", volume: 0.44 },
  deal: { sound: "navigate", volume: 0.38 },
  pass: { sound: "ready", volume: 0.32 },
} satisfies Record<string, { sound: SoundName; volume: number }>;

export function playGizmoCue(cue: keyof typeof cues) {
  if (!navigator.userActivation?.hasBeenActive || document.hidden || !gizmoSoundsEnabled()) return;
  const { sound, volume } = cues[cue];
  setEnabled(true);
  play(sound, { volume });
}

const SETTLE_MS = 720;
const DECAY = 10;
const FREQUENCY = 16;
const SPRING_ID = "little-table:gizmo-spring";

function springFrames(transform: (displacement: number) => string, initialVelocity: number) {
  return Array.from({ length: 46 }, (_, index) => {
    const t = (index / 45) * (SETTLE_MS / 1000);
    const displacement =
      Math.exp(-DECAY * t) *
      (Math.cos(FREQUENCY * t) + ((initialVelocity + DECAY) / FREQUENCY) * Math.sin(FREQUENCY * t));
    return { transform: transform(index === 45 ? 0 : displacement) };
  });
}

export function springGizmo(
  element: Element,
  transform: (displacement: number) => string,
  initialVelocity = 0,
) {
  for (const previous of element.getAnimations()) {
    if (previous.id === SPRING_ID) previous.cancel();
  }
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const animation = motion.matches
    ? null
    : element.animate(springFrames(transform, initialVelocity), {
        duration: SETTLE_MS,
        id: SPRING_ID,
      });
  const cancel = () => animation?.cancel();
  if (!animation) return cancel;
  motion.addEventListener("change", cancel);
  const cleanup = () => motion.removeEventListener("change", cancel);
  void animation.finished.then(cleanup, cleanup);
  return cancel;
}
