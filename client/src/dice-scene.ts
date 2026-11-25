import type { DiceLaunch } from "../../src/dice-notation";
import type { DieKind } from "./dice-solids";

import { drawAtlas, NUMERAL_FONT } from "./dice-atlas";
import { addDiceControls, type DiceControls } from "./dice-controls";
import { blend, lerp, multiply, type Quat, type Vec } from "./dice-math";
import { meshOf } from "./dice-mesh";
import { FPS, FRAME_STRIDE } from "./dice-physics";
import {
  createRenderer,
  EYE,
  type Look,
  type Model,
  type Pose,
  type Rgb,
  type Tier,
} from "./dice-renderer";
import { solid } from "./dice-solids";
import { cameraFacingOf, type Die, type Planned, throwDice } from "./dice-throw";

type ThrowOptions = DiceControls & { kept: readonly boolean[]; launch?: DiceLaunch; seed: number };

export type DiceThrow = {
  dispose: () => void;
  /** Resolves when the dice settle or another roll replaces them. */
  roll: (dice: Die[], options: ThrowOptions) => Promise<void>;
};

const LOOK: "brand" | "ivory" = "brand";
const IVORY: Look = { body: [0.945, 0.91, 0.847], ink: [0.165, 0.129, 0.114] };
const LIGHT_INK: Rgb = [1, 0.973, 0.949];
const FALLBACK_BODY: Rgb = [0.184, 0.435, 0.875];
const BALL_SMOOTH = 0.5;
const SETTLE_FADE_FRAMES = 15;
const SLICE_MS = 6;
const TIER_KEY = "tabletop.dice-tier";

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
  const brightness = 0.2126 * body[0] + 0.7152 * body[1] + 0.0722 * body[2];
  return { body, ink: brightness > 0.6 ? IVORY.ink : LIGHT_INK };
}

function forcedTier(): Tier | null {
  try {
    const forced = localStorage.getItem(TIER_KEY);
    return forced === "low" || forced === "full" ? forced : null;
  } catch {
    // WARNING: Reading localStorage can throw when the browser blocks storage.
    return null;
  }
}

const models = new Map<DieKind, Model>();

function modelOf(kind: DieKind): Model {
  const known = models.get(kind);
  if (known !== undefined) return known;
  const { ball, core, r } = solid(kind);
  // WARNING: A clearcoat highlight can obscure the entire numeric face of a d100.
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

function dimFrom({ thrown }: Planned, kept: readonly boolean[]): (number | null)[] {
  return thrown.frames.map((frames, index) => {
    if (kept[index] !== false) return null;
    const last = frames.length - FRAME_STRIDE;
    const still = (at: number) =>
      [0, 2, 3, 4, 5, 6].every((k) => Math.abs(frames[at + k]! - frames[last + k]!) < 1e-9);
    let from = last;
    while (from >= FRAME_STRIDE && still(from - FRAME_STRIDE)) from -= FRAME_STRIDE;
    return from / FRAME_STRIDE;
  });
}

function posesAt(
  { bodies, numbering, thrown }: Planned,
  dimming: (number | null)[],
  facing: (Quat | null)[],
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
    const spun = multiply(blend(rotation(from), rotation(to), share), numbering[index]!);
    const correction = facing[index];
    return {
      dimmed: shareIn * shareIn * (3 - 2 * shareIn),
      model: modelOf(body.kind),
      position: lerp(position(from), position(to), share),
      rotation: correction == null ? spun : multiply(correction, spun),
      size: thrown.sizes[index]!,
    };
  });
}

/** onError receives failures during redraws outside a roll, including resizes and context restoration. */
export async function createDiceThrow(
  host: HTMLElement,
  onError: (error: unknown) => void,
): Promise<DiceThrow> {
  // WARNING: Wait for Outfit before drawing the atlas. Canvas would otherwise keep the fallback glyphs.
  await document.fonts.load(NUMERAL_FONT, "0123456789");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "pointer-events-none absolute inset-0 size-full";
  let shown: Pose[] = [];
  let controls: ReturnType<typeof addDiceControls> | null = null;
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
        let facing: (Quat | null)[] = [];
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
              facing = cameraFacingOf(planned, EYE);
              startedAt = now;
              length = Math.max(
                planned.thrown.frames[0]!.length / FRAME_STRIDE - 1,
                ...dimming.map((dim) => (dim === null ? 0 : dim + SETTLE_FADE_FRAMES)),
              );
            }
            const frame = Math.min(((now - startedAt) / 1000) * FPS, length);
            shown = posesAt(planned, dimming, facing, frame);
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
