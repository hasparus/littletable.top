// Plays the shared throw on a transparent canvas inside `host`: simulates it
// from the roll's seed, turns each die's numbering so the server's value is
// on top, and draws the recorded frames. Values never come from the physics.

import type { DieKind } from "./dice-solids";

import { drawAtlas, faceSpot, NUMERAL_FONT, numeralSpot } from "./dice-atlas";
import {
  blend,
  lerp,
  multiply,
  normalize,
  type Quat,
  rotate,
  rotationBetween,
  sub,
  type Vec,
} from "./dice-math";
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
import { type Die, finalRotation, type Planned, throwDice } from "./dice-throw";

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
// How far a ball's faces are lit as a sphere, and the frames a result's mark
// takes to come in.
const BALL_SMOOTH = 0.5;
const MARK_FRAMES = 15;
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
    spot: numeralSpot(kind),
  };
  models.set(kind, made);
  return made;
}

// Per die, a turn of the whole die that is kept through the throw. A ball's
// value ends straight up, which from a camera over the tray's middle is off
// the middle of a ball near the tray's edge, where a neighbouring number
// would look like the result; the ball is tipped to face the camera from
// where it comes to rest.
function facingOf({ bodies, thrown }: Planned): (Quat | null)[] {
  return bodies.map((body, index) => {
    if (!solid(body.kind).ball) return null;
    const frames = thrown.frames[index]!;
    const at = frames.length - FRAME_STRIDE;
    const rest: Vec = [frames[at]!, frames[at + 1]!, frames[at + 2]!];
    return rotationBetween([0, 1, 0], normalize(sub(EYE, rest)));
  });
}

// Per die, whether its numerals are drawn upside down: a d10's numbering can
// be turned only one way, which leaves the number on top reading any way
// round; drawn either way up, it reads within a quarter turn of upright.
function upsideDownOf({ bodies, numbering, thrown }: Planned): boolean[] {
  return bodies.map((body, index) => {
    const shape = solid(body.kind);
    const top = shape.features.find((feature) => feature.value === body.value);
    if (numeralSpot(body.kind) === null || top === undefined || top.up === null) return false;
    const shown = multiply(finalRotation(thrown, index), numbering[index]!);
    // NOTE: z runs down the screen.
    return rotate(shown, top.up)[2] > 0;
  });
}

// Per die, the face to mark as its result and the frame from which it lies
// still. A ball shows a dozen numbers at once and the one that catches the
// light is rarely the one on top, so its result is told apart once it has
// stopped; while it rolls every face looks alike.
type Result = { columns: number; from: number; x: number; y: number };

function resultsOf({ bodies, thrown }: Planned): (Result | null)[] {
  return bodies.map((body, index) => {
    const shape = solid(body.kind);
    const face = shape.features.findIndex((feature) => feature.value === body.value);
    if (!shape.ball || face === -1) return null;
    const frames = thrown.frames[index]!;
    const last = frames.length - FRAME_STRIDE;
    // NOTE: the height is left out: the last frame alone sets it exactly.
    const still = (at: number) =>
      [0, 2, 3, 4, 5, 6].every((k) => Math.abs(frames[at + k]! - frames[last + k]!) < 1e-9);
    let from = last;
    while (from >= FRAME_STRIDE && still(from - FRAME_STRIDE)) from -= FRAME_STRIDE;
    return { ...faceSpot(body.kind, face), from: from / FRAME_STRIDE };
  });
}

type Presented = { facing: (Quat | null)[]; results: (Result | null)[]; upsideDown: boolean[] };

// The dice between two recorded frames, each with its numbering turned.
function posesAt(
  { bodies, numbering, thrown }: Planned,
  { facing, results, upsideDown }: Presented,
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
    const turned = multiply(blend(rotation(from), rotation(to), share), numbering[index]!);
    const toCamera = facing[index] ?? null;
    const result = results[index] ?? null;
    const shareIn =
      result === null ? 0 : Math.min(Math.max((frame - result.from) / MARK_FRAMES, 0), 1);
    return {
      mark: result === null ? null : { ...result, amount: shareIn * shareIn * (3 - 2 * shareIn) },
      model: modelOf(body.kind),
      position: lerp(position(from), position(to), share),
      rotation: toCamera === null ? turned : multiply(toCamera, turned),
      upsideDown: upsideDown[index]!,
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
        let presented: Presented = { facing: [], results: [], upsideDown: [] };
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
              presented = {
                facing: facingOf(planned),
                results: resultsOf(planned),
                upsideDown: upsideDownOf(planned),
              };
              startedAt = now;
              // The throw, and the marks of results that came to rest late.
              length = Math.max(
                planned.thrown.frames[0]!.length / FRAME_STRIDE - 1,
                ...presented.results.map((result) =>
                  result === null ? 0 : result.from + MARK_FRAMES,
                ),
              );
            }
            const frame = Math.min(((now - startedAt) / 1000) * FPS, length);
            shown = posesAt(planned, presented, frame);
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
