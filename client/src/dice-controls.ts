import type { DiceLaunch } from "../../src/dice-notation";
import type { Vec } from "./dice-math";
import type { Pose } from "./dice-renderer";

import { multiply, normalize, rotationBetween } from "./dice-math";
import { FLICK_REACH_X, FLICK_REACH_Z, FLICK_SPEED } from "./dice-physics";
import { diceScreen } from "./dice-renderer";

export type DiceControls = {
  nameDie: (index: number) => string;
  reroll: (index: number, launch?: DiceLaunch) => Promise<boolean>;
};

const DRAG_THRESHOLD = 4;
const SPEED_SAMPLE_MS = 100;
const LIFT = 0.7;
const clamp = (value: number, reach = 1) => Math.max(-reach, Math.min(value, reach));

type Sample = { at: number; position: Vec };
type Grip = {
  index: number;
  moved: boolean;
  original: Pose;
  pointer: number;
  samples: Sample[];
  x: number;
  y: number;
};

/** Hit-tests the projected surfaces of settled dice and drags them in a raised plane. */
export function addDiceControls(
  host: HTMLElement,
  poses: Pose[],
  redraw: () => void,
  { nameDie, reroll }: DiceControls,
) {
  const screen = () => diceScreen(host.clientWidth, host.clientHeight);
  let grip: Grip | null = null;
  let pending = false;
  let removed = false;

  async function roll(index: number, launch?: DiceLaunch, original?: Pose) {
    if (pending || removed) return;
    pending = true;
    for (const button of buttons) button.setAttribute("aria-disabled", "true");
    const accepted = await reroll(index, launch).catch(() => false);
    pending = false;
    if (!removed) {
      for (const button of buttons) button.removeAttribute("aria-disabled");
      if (!accepted && original !== undefined) {
        poses[index] = original;
        redraw();
      }
    }
  }

  function move(event: PointerEvent, held: Grip) {
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    held.moved = true;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    const view = screen();
    const from = held.original.position;
    const origin = view.project(from);
    const pointer = view.atHeight({ x: origin.x + dx, y: origin.y + dy }, from[1] + LIFT);
    const [x, y, z] = pointer;
    const position: Vec = [clamp(x, FLICK_REACH_X), y, clamp(z, FLICK_REACH_Z)];
    const tilt = rotationBetween(
      [0, 1, 0],
      normalize([-(position[0] - from[0]) * 0.09, 1, -(position[2] - from[2]) * 0.09]),
    );
    poses[held.index] = {
      ...held.original,
      position,
      rotation: multiply(tilt, held.original.rotation),
    };
    held.samples = held.samples.filter(({ at }) => at >= event.timeStamp - SPEED_SAMPLE_MS);
    held.samples.push({ at: event.timeStamp, position: pointer });
    redraw();
  }

  function finish(event: PointerEvent, held: Grip) {
    move(event, held);
    grip = null;
    if (!held.moved) return;
    const [x, , z] = poses[held.index]!.position;
    const recent = held.samples[0];
    const [pointerX, , pointerZ] = held.samples.at(-1)!.position;
    const seconds =
      recent === undefined ? 1 : Math.max(0.015, (event.timeStamp - recent.at) / 1000);
    const speedX = (pointerX - (recent?.position[0] ?? pointerX)) / seconds;
    const speedZ = (pointerZ - (recent?.position[2] ?? pointerZ)) / seconds;
    void roll(
      held.index,
      {
        vx: clamp(speedX / FLICK_SPEED),
        vz: clamp(speedZ / FLICK_SPEED),
        x: x / FLICK_REACH_X,
        z: z / FLICK_REACH_Z,
      },
      held.original,
    );
  }

  const buttons = poses.map((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.dieObject = "";
    button.setAttribute("aria-label", nameDie(index));
    button.className =
      "pointer-events-auto absolute touch-none cursor-grab bg-transparent select-none focus-visible:bg-border-focus/30 focus-visible:outline-none active:cursor-grabbing";
    button.addEventListener("pointerdown", (event) => {
      if (pending || grip !== null || event.button !== 0) return;
      event.preventDefault();
      const original = poses[index]!;
      const view = screen();
      const pointer = view.atHeight(view.project(original.position), original.position[1] + LIFT);
      grip = {
        index,
        moved: false,
        original,
        pointer: event.pointerId,
        samples: [{ at: event.timeStamp, position: pointer }],
        x: event.clientX,
        y: event.clientY,
      };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", (event) => {
      if (grip?.pointer === event.pointerId) move(event, grip);
    });
    button.addEventListener("pointerup", (event) => {
      if (grip?.pointer === event.pointerId) finish(event, grip);
    });
    button.addEventListener("lostpointercapture", (event) => {
      if (grip?.pointer !== event.pointerId) return;
      poses[index] = grip.original;
      grip = null;
      redraw();
    });
    button.addEventListener("click", (event) => {
      if (event.detail === 0 && grip === null) void roll(index);
    });
    host.append(button);
    return button;
  });

  return {
    focus: () => buttons[0]?.focus({ preventScroll: true }),
    measure() {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      const view = screen();
      for (const [index, button] of buttons.entries()) {
        const outline = view.outline(poses[index]!);
        const xs = outline.map(([x]) => x);
        const ys = outline.map(([, y]) => y);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        Object.assign(button.style, {
          clipPath: `polygon(${outline.map(([x, y]) => `${x - left}px ${y - top}px`).join(", ")})`,
          height: `${Math.max(...ys) - top}px`,
          left: `${left}px`,
          top: `${top}px`,
          width: `${Math.max(...xs) - left}px`,
          zIndex: grip?.index === index ? "1" : "auto",
        });
      }
    },
    remove() {
      removed = true;
      grip = null;
      for (const button of buttons) button.remove();
    },
  };
}
