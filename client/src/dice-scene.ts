// Plays the shared throw on a transparent canvas inside `host`: simulates it
// from the roll's seed, turns each die's numbering so the server's value is
// on top, and draws the recorded frames. Values never come from the physics.

import type { DiceLaunch } from "../../src/dice-notation";
import type { DieKind } from "./dice-solids";

import { drawAtlas, NUMERAL_FONT } from "./dice-atlas";
import { addDiceControls, type DiceControls } from "./dice-controls";
import { blend, lerp, multiply, type Quat, type Vec } from "./dice-math";
import { meshOf } from "./dice-mesh";
import { FPS, FRAME_STRIDE } from "./dice-physics";
import {
  createRenderer,
  type Look,
  type Model,
  type Pose,
  type Rgb,
  type Tier,
} from "./dice-renderer";
import { solid } from "./dice-solids";
import { type Die, type Planned, throwDice } from "./dice-throw";

type ThrowOptions = DiceControls & { kept: readonly boolean[]; launch?: DiceLaunch; seed: number };

export type DiceThrow = {
  dispose: () => void;
  // Settles when the dice lie still, or at once when another roll replaces it.
  roll: (dice: Die[], options: ThrowOptions) => Promise<void>;
};

// The dice wear the deployer's brand colour; "ivory" is the other look.
const LOOK: "brand" | "ivory" = "brand";
const IVORY: Look = { body: [0.945, 0.91, 0.847], ink: [0.165, 0.129, 0.114] };
const LIGHT_INK: Rgb = [1, 0.973, 0.949];
const FALLBACK_BODY: Rgb = [0.184, 0.435, 0.875];
// How far a ball's faces are lit as a sphere, and the frames it takes to dim
// dice dropped by the notation.
const BALL_SMOOTH = 0.5;
const SETTLE_FADE_FRAMES = 15;
// The simulation's share of a frame on a slow device, before it yields.
const SLICE_MS = 6;
// NOTE: for looking at a tier on a device that would pick the other one:
// localStorage.setItem("tabletop.dice-tier", "low" | "full").
const TIER_KEY = "tabletop.dice-tier";

// "#rgb" or "#rrggbb", as the build writes the brand colours.
function parseHex(text: string): Rgb | null {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(text.trim())?.[1];
  if (hex === undefined) return null;
  const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit) : hex.match(/../gu);
  const [r, g, b] = (digits ?? []).map((pair) => Number.parseInt(pair, 16) / 255);
  return r === undefined || g === undefined || b === undefined ? null : [r, g, b];
}

function lookOf(): Look {
  if (LOOK === "ivory") return IVORY;
  const brand = getComputedStyle(document.documentElement).getPropertyValue("--brand-primary");
  const body = parseHex(brand) ?? FALLBACK_BODY;
  // A pale brand takes the dark ink, as a pale die does.
  const brightness = 0.2126 * body[0] + 0.7152 * body[1] + 0.0722 * body[2];
  return { body, ink: brightness > 0.6 ? IVORY.ink : LIGHT_INK };
}

function forcedTier(): Tier | null {
  try {
    const forced = localStorage.getItem(TIER_KEY);
    return forced === "low" || forced === "full" ? forced : null;
  } catch {
    // Storage can be denied outright; the device then picks its own tier.
    return null;
  }
}

const models = new Map<DieKind, Model>();

function modelOf(kind: DieKind): Model {
  const known = models.get(kind);
  if (known !== undefined) return known;
  const { ball, core, r } = solid(kind);
  // NOTE: the clearcoat's highlight is a point on a rounded edge, but a
  // whole face of a ball when that face mirrors the light, and it whites the
  // number out; the ball goes without.
  const coat = ball ? 0 : 1;
  const made = {
    atlas: drawAtlas(kind),
    coat,
    core,
    mesh: meshOf(kind),
    rounding: r,
    smooth: ball ? BALL_SMOOTH : 0,
  };
  models.set(kind, made);
  return made;
}

// Dropped dice start to dim once they come to rest.
function dimFrom({ thrown }: Planned, kept: readonly boolean[]): (number | null)[] {
  return thrown.frames.map((frames, index) => {
    if (kept[index] !== false) return null;
    const last = frames.length - FRAME_STRIDE;
    // NOTE: the height is left out: the last frame alone sets it exactly.
    const still = (at: number) =>
      [0, 2, 3, 4, 5, 6].every((k) => Math.abs(frames[at + k]! - frames[last + k]!) < 1e-9);
    let from = last;
    while (from >= FRAME_STRIDE && still(from - FRAME_STRIDE)) from -= FRAME_STRIDE;
    return from / FRAME_STRIDE;
  });
}

// The dice between two recorded frames. The mesh and its engraved numbers
// move together for the entire throw.
function posesAt(
  { bodies, numbering, thrown }: Planned,
  dimming: (number | null)[],
  frame: number,
): Pose[] {
  return bodies.map((body, index) => {
    const frames = thrown.frames[index]!;
    const last = frames.length / FRAME_STRIDE - 1;
    const from = Math.min(Math.floor(frame), last) * FRAME_STRIDE;
    const to = Math.min(Math.floor(frame) + 1, last) * FRAME_STRIDE;
    const share = frame - Math.floor(frame);
    const position = (at: number): Vec => [frames[at]!, frames[at + 1]!, frames[at + 2]!];
    const rotation = (at: number): Quat => [
      frames[at + 3]!,
      frames[at + 4]!,
      frames[at + 5]!,
      frames[at + 6]!,
    ];
    const dim = dimming[index] ?? null;
    const shareIn = dim === null ? 0 : Math.min(Math.max((frame - dim) / SETTLE_FADE_FRAMES, 0), 1);
    return {
      dimmed: shareIn * shareIn * (3 - 2 * shareIn),
      model: modelOf(body.kind),
      position: lerp(position(from), position(to), share),
      rotation: multiply(blend(rotation(from), rotation(to), share), numbering[index]!),
      size: thrown.sizes[index]!,
    };
  });
}

// `onError` hears of a failure outside a roll: a redraw after a resize or a
// restored context.
export async function createDiceThrow(
  host: HTMLElement,
  onError: (error: unknown) => void,
): Promise<DiceThrow> {
  // NOTE: the numerals are drawn on a canvas, which uses whatever font is
  // ready at that moment; this waits for Outfit's file.
  await document.fonts.load(NUMERAL_FONT, "0123456789");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "pointer-events-none absolute inset-0 size-full";
  let shown: Pose[] = [];
  let controls: ReturnType<typeof addDiceControls> | null = null;
  // NOTE: the board's own theme (tldraw's, a class on its container) decides
  // how strong the shadows are, not the device's.
  function redraw() {
    renderer.draw(shown, document.querySelector(".tl-theme__dark") !== null);
    controls?.measure();
  }
  const redrawSafely = () => {
    try {
      redraw();
    } catch (error) {
      onError(error);
    }
  };
  const renderer = createRenderer(canvas, {
    look: lookOf(),
    onRestored: redrawSafely,
    tier: forcedTier(),
  });
  host.append(canvas);
  host.dataset.diceTier = renderer.tier;
  const resized = new ResizeObserver(redrawSafely);
  resized.observe(host);
  let frameRequest = 0;
  let finish: (() => void) | null = null;
  const stop = () => {
    cancelAnimationFrame(frameRequest);
    controls?.remove();
    controls = null;
    finish?.();
    finish = null;
  };

  return {
    dispose: () => {
      stop();
      resized.disconnect();
      renderer.dispose();
      canvas.remove();
    },
    roll: async (dice, { kept, launch, seed, ...input }) =>
      new Promise<void>((resolve, reject) => {
        const focus =
          host.contains(document.activeElement) &&
          document.activeElement?.matches(":focus-visible");
        stop();
        finish = resolve;
        const run = throwDice(dice, seed, launch);
        let planned: Planned | null = null;
        let dimming: (number | null)[] = [];
        let startedAt = 0;
        let length = 0;
        const tick = (now: number) => {
          try {
            if (planned === null) {
              if (!run.advance(performance.now() + SLICE_MS)) {
                frameRequest = requestAnimationFrame(tick);
                return;
              }
              planned = run.planned();
              dimming = dimFrom(planned, kept);
              startedAt = now;
              // Include the fades of dice that came to rest late.
              length = Math.max(
                planned.thrown.frames[0]!.length / FRAME_STRIDE - 1,
                ...dimming.map((dim) => (dim === null ? 0 : dim + SETTLE_FADE_FRAMES)),
              );
            }
            const frame = Math.min(((now - startedAt) / 1000) * FPS, length);
            shown = posesAt(planned, dimming, frame);
            redraw();
            if (frame < length) frameRequest = requestAnimationFrame(tick);
            else {
              controls = addDiceControls(host, shown, redrawSafely, input);
              controls.measure();
              if (focus) controls.focus();
              finish = null;
              resolve();
            }
          } catch (error) {
            finish = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        frameRequest = requestAnimationFrame(tick);
      }),
  };
}
