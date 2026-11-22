// Plays the shared throw on a transparent canvas inside `host`: simulates it
// from the roll's seed, turns each die's numbering so the server's value is
// on top, and draws the recorded frames. Values never come from the physics.

import type { DieKind } from "./dice-solids";

import { drawAtlas, NUMERAL_FONT } from "./dice-atlas";
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

export type DiceThrow = {
  dispose: () => void;
  // Settles when the dice lie still, or at once when another roll replaces it.
  roll: (dice: Die[], seed: number) => Promise<void>;
};

// The dice wear the deployer's brand colour; "ivory" is the other look.
const LOOK: "brand" | "ivory" = "brand";
const IVORY: Look = { body: [0.945, 0.91, 0.847], ink: [0.165, 0.129, 0.114] };
const LIGHT_INK: Rgb = [1, 0.973, 0.949];
const FALLBACK_BODY: Rgb = [0.184, 0.435, 0.875];
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
  const { inradius, radius } = solid(kind);
  const made = { atlas: drawAtlas(kind), inradius, mesh: meshOf(kind), radius };
  models.set(kind, made);
  return made;
}

// The dice between two recorded frames, each with its numbering turned.
function posesAt({ bodies, numbering, thrown }: Planned, frame: number): Pose[] {
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
    return {
      model: modelOf(body.kind),
      position: lerp(position(from), position(to), share),
      rotation: multiply(blend(rotation(from), rotation(to), share), numbering[index]!),
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
  canvas.className = "pointer-events-none absolute inset-0 size-full";
  let shown: Pose[] = [];
  // NOTE: the board's own theme (tldraw's, a class on its container) decides
  // how strong the shadows are, not the device's.
  function redraw() {
    renderer.draw(shown, document.querySelector(".tl-theme__dark") !== null);
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
  let current = 0;
  let frameRequest = 0;

  return {
    dispose: () => {
      current += 1;
      cancelAnimationFrame(frameRequest);
      resized.disconnect();
      renderer.dispose();
      canvas.remove();
    },
    roll: async (dice, seed) =>
      new Promise<void>((resolve, reject) => {
        current += 1;
        const mine = current;
        cancelAnimationFrame(frameRequest);
        const run = throwDice(dice, seed);
        let planned: Planned | null = null;
        let startedAt = 0;
        let length = 0;
        const tick = (now: number) => {
          if (mine !== current) return resolve();
          try {
            if (planned === null) {
              if (!run.advance(performance.now() + SLICE_MS)) {
                frameRequest = requestAnimationFrame(tick);
                return;
              }
              planned = run.planned();
              startedAt = now;
              length = planned.thrown.frames[0]!.length / FRAME_STRIDE - 1;
            }
            const frame = Math.min(((now - startedAt) / 1000) * FPS, length);
            shown = posesAt(planned, frame);
            redraw();
            if (frame < length) frameRequest = requestAnimationFrame(tick);
            else resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        frameRequest = requestAnimationFrame(tick);
      }),
  };
}
