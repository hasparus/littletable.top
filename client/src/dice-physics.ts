import type { DiceLaunch } from "../../src/dice-notation";

import {
  add,
  blend,
  cross,
  dot,
  generator,
  length,
  multiply,
  normalizeQuat,
  type Quat,
  randomRotation,
  rotate,
  rotationBetween,
  scale,
  sub,
  type Vec,
} from "./dice-math";
import { type DieKind, solid, type Solid } from "./dice-solids";

/** Tray width in die units. X goes across the screen, z goes down, and y goes up. */
export const TRAY_WIDTH = 10;
export const TRAY_DEPTH = 14;
export const FLICK_REACH_X = TRAY_WIDTH / 2 - 1.3;
export const FLICK_REACH_Z = TRAY_DEPTH / 2 - 1.3;
export const FLICK_SPEED = 16;
export const FPS = 60;
/** Numbers per frame per die in order x, y, z, qx, qy, qz, qw. */
export const FRAME_STRIDE = 7;

const SUBSTEPS = 4;
const DT = 1 / (FPS * SUBSTEPS);
const GRAVITY = 70;
const ITERATIONS = 8;
const FLOOR_FRICTION = 0.45;
const PRESSED_FRICTION = 0.06;
const RESTITUTION = 0.32;
const DICE_RESTITUTION = 0.4;
const BOUNCE_MIN = 1.2;
const SLOP = 0.005;
const BAUMGARTE = 0.25;
// WARNING: Use literal damping factors per substep. Math.pow can vary across engines.
const LINEAR_DAMPING = 0.9992;
const ANGULAR_DAMPING = 0.9985;
const ROLLING_DAMPING = 0.998;
const BALL_DRAG = 14;
const SLEEP_SPEED2 = 0.04;
const SLEEP_SPIN2 = 0.04;
const SLEEP_SECONDS = 0.2;
const MAX_SECONDS = 3.2;
const CROWD_FRAMES = 4;
const CALM_BALLS = 5;
const CROWD = 20;
const SMALLEST_BALL = 1;
const SNAP_FRAMES = 12;
const FLAT = 0.9994;

type Body = {
  angular: Vec;
  asleep: boolean;
  ball: boolean;
  invInertia: number;
  position: Vec;
  rotation: Quat;
  size: number;
  solid: Solid;
  sphere: number;
  still: number;
  velocity: Vec;
};

type Contact = {
  arm: Vec;
  body: number;
  depth: number;
  floor: boolean;
  friction: Vec;
  impulse: number;
  normal: Vec;
  target: number;
};

type Pair = { a: number; b: number; depth: number; impulse: number; normal: Vec; target: number };

const WALLS: { normal: Vec; offset: number }[] = [
  { normal: [1, 0, 0], offset: -TRAY_WIDTH / 2 },
  { normal: [-1, 0, 0], offset: -TRAY_WIDTH / 2 },
  { normal: [0, 0, 1], offset: -TRAY_DEPTH / 2 },
  { normal: [0, 0, -1], offset: -TRAY_DEPTH / 2 },
];
const UP: Vec = [0, 1, 0];

export type Throw = {
  /** Per die, FRAME_STRIDE numbers per frame at FPS. */
  frames: Float64Array[];
  /** Time in seconds until every die slept, or the cap if the throw timed out. */
  settledAt: number;
  /** Per-die scale relative to its solid, reduced for crowded d100 rolls. */
  sizes: number[];
  /** Number of dice eased onto a face because they did not settle flat. */
  snapped: number;
};

function sphereOf(shape: Solid): number {
  if (shape.ball) return shape.inradius;
  return shape.kind === "d4" ? shape.radius * 0.72 : shape.radius * 0.93;
}

export function ballSize(kinds: DieKind[]): number {
  let balls = 0;
  let others = 0;
  for (const kind of kinds) {
    const shape = solid(kind);
    if (shape.ball) balls += 1;
    else others += sphereOf(shape) * sphereOf(shape);
  }
  if (balls === 0) return 1;
  const radius = Math.max(SMALLEST_BALL, Math.sqrt(Math.max(CROWD - others, 0) / balls));
  return Math.min(1, radius / solid("d100").inradius);
}

function spawn(kinds: DieKind[], seed: number): Body[] {
  const random = generator(seed);
  const ball = ballSize(kinds);
  return kinds.map((kind, i) => {
    const shape = solid(kind);
    const size = shape.ball ? ball : 1;
    const column = i % 3;
    const layer = Math.floor(i / 3);
    const position: Vec = [
      TRAY_WIDTH / 2 - 1.3 - column * 1.6 - random() * 0.4,
      2.2 + (layer % 3) * 1.9 + random() * 0.6,
      TRAY_DEPTH / 2 - 1.4 - Math.floor(layer / 3) * 1.7 - random() * 0.4,
    ];
    const speed = 9 + random() * 5;
    const sideways = 0.35 + random() * 0.35;
    const velocity: Vec = [-speed * sideways, -1 - random() * 2, -speed];
    const angular: Vec = [(random() - 0.5) * 36, (random() - 0.5) * 36, (random() - 0.5) * 36];
    const mean = ((shape.inradius + shape.radius) / 2) * size;
    return {
      angular,
      asleep: false,
      ball: shape.ball,
      invInertia: 1 / (0.4 * mean * mean),
      position,
      rotation: randomRotation(random),
      size,
      solid: shape,
      sphere: sphereOf(shape) * size,
      still: 0,
      velocity,
    };
  });
}

function flatPose(body: Body): { dot: number; position: Vec; rotation: Quat } {
  if (body.ball) {
    return {
      dot: 1,
      position: [body.position[0], body.sphere, body.position[2]],
      rotation: body.rotation,
    };
  }
  let best = -2;
  let down: Vec = [0, -1, 0];
  for (const face of body.solid.faces) {
    const normal = rotate(body.rotation, face.normal);
    if (-normal[1] > best) [best, down] = [-normal[1], normal];
  }
  return {
    dot: best,
    position: [body.position[0], body.solid.inradius, body.position[2]],
    rotation: normalizeQuat(multiply(rotationBetween(down, [0, -1, 0]), body.rotation)),
  };
}

function floorContacts(body: Body, index: number, contacts: Contact[]) {
  if (body.ball) {
    const distance = body.position[1] - body.sphere;
    if (distance > SLOP) return;
    const speed = body.velocity[1];
    contacts.push({
      arm: [0, -body.sphere, 0],
      body: index,
      depth: -distance,
      floor: true,
      friction: [0, 0, 0],
      impulse: 0,
      normal: UP,
      target: speed < -BOUNCE_MIN ? -RESTITUTION * speed : 0,
    });
    return;
  }
  for (const corner of body.solid.core) {
    const arm = rotate(body.rotation, corner);
    const point = add(body.position, arm);
    const distance = point[1] - body.solid.r;
    if (distance > SLOP) continue;
    const reach = sub(arm, scale(UP, body.solid.r));
    const speed = dot(add(body.velocity, cross(body.angular, reach)), UP);
    contacts.push({
      arm: reach,
      body: index,
      depth: -distance,
      floor: true,
      friction: [0, 0, 0],
      impulse: 0,
      normal: UP,
      target: speed < -BOUNCE_MIN ? -RESTITUTION * speed : 0,
    });
  }
}

function wallContacts(body: Body, index: number, contacts: Contact[]) {
  for (const wall of WALLS) {
    const distance = dot(wall.normal, body.position) - wall.offset - body.sphere;
    if (distance > SLOP) continue;
    const speed = dot(body.velocity, wall.normal);
    contacts.push({
      arm: [0, 0, 0],
      body: index,
      depth: -distance,
      floor: false,
      friction: [0, 0, 0],
      impulse: 0,
      normal: wall.normal,
      target: speed < -BOUNCE_MIN ? -RESTITUTION * speed : 0,
    });
  }
}

function pairsOf(bodies: Body[]): Pair[] {
  const pairs: Pair[] = [];
  for (let a = 0; a < bodies.length; a += 1)
    for (let b = a + 1; b < bodies.length; b += 1) {
      const first = bodies[a]!;
      const second = bodies[b]!;
      if (first.asleep && second.asleep) continue;
      const between = sub(second.position, first.position);
      const distance = length(between);
      const reach = first.sphere + second.sphere;
      if (distance >= reach || distance === 0) continue;
      const normal = scale(between, 1 / distance);
      const speed = dot(sub(second.velocity, first.velocity), normal);
      const depth = reach - distance;
      if ((first.asleep || second.asleep) && speed > -0.1 && depth < 4 * SLOP) continue;
      for (const body of [first, second])
        if (body.asleep) {
          body.asleep = false;
          body.still = 0;
        }
      pairs.push({
        a,
        b,
        depth,
        impulse: 0,
        normal,
        target: speed < -BOUNCE_MIN ? -DICE_RESTITUTION * speed : 0,
      });
    }
  return pairs;
}

function solveContact(contact: Contact, body: Body, pressed: boolean) {
  const speed = dot(add(body.velocity, cross(body.angular, contact.arm)), contact.normal);
  const armCross = cross(contact.arm, contact.normal);
  const mass = 1 + body.invInertia * dot(armCross, armCross);
  const bias = (BAUMGARTE / DT) * Math.max(contact.depth - SLOP, 0);
  const total = Math.max(contact.impulse + (Math.max(contact.target, bias) - speed) / mass, 0);
  const change = total - contact.impulse;
  contact.impulse = total;
  body.velocity = add(body.velocity, scale(contact.normal, change));
  body.angular = add(body.angular, scale(armCross, body.invInertia * change));
  if (!contact.floor) return;
  const point = add(body.velocity, cross(body.angular, contact.arm));
  const slide = sub(point, scale(contact.normal, dot(point, contact.normal)));
  const slideSpeed = length(slide);
  if (slideSpeed < EPSILON) return;
  const along = scale(slide, 1 / slideSpeed);
  const alongCross = cross(contact.arm, along);
  const alongMass = 1 + body.invInertia * dot(alongCross, alongCross);
  let friction = add(contact.friction, scale(along, -slideSpeed / alongMass));
  const cap = (pressed ? PRESSED_FRICTION : FLOOR_FRICTION) * contact.impulse;
  const frictionSize = length(friction);
  if (frictionSize > cap) friction = scale(friction, cap / frictionSize);
  const delta = sub(friction, contact.friction);
  contact.friction = friction;
  body.velocity = add(body.velocity, delta);
  body.angular = add(body.angular, scale(cross(contact.arm, delta), body.invInertia));
}

const EPSILON = 1e-9;

function solvePair(pair: Pair, first: Body, second: Body) {
  const speed = dot(sub(second.velocity, first.velocity), pair.normal);
  const bias = (BAUMGARTE / DT) * Math.max(pair.depth - SLOP, 0);
  const total = Math.max(pair.impulse + (Math.max(pair.target, bias) - speed) / 2, 0);
  const change = total - pair.impulse;
  pair.impulse = total;
  first.velocity = sub(first.velocity, scale(pair.normal, change));
  second.velocity = add(second.velocity, scale(pair.normal, change));
}

function step(bodies: Body[]) {
  const contacts: Contact[] = [];
  for (const [index, body] of bodies.entries()) {
    if (body.asleep) continue;
    body.velocity[1] -= GRAVITY * DT;
    wallContacts(body, index, contacts);
    floorContacts(body, index, contacts);
  }
  const pairs = pairsOf(bodies);
  // WARNING: Disable floor friction for pressed dice so they cannot balance against a wall or another die.
  const pressed = new Set<number>();
  for (const contact of contacts) if (!contact.floor) pressed.add(contact.body);
  for (const pair of pairs) pressed.add(pair.a).add(pair.b);
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (const contact of contacts)
      solveContact(contact, bodies[contact.body]!, pressed.has(contact.body));
    for (const pair of pairs) solvePair(pair, bodies[pair.a]!, bodies[pair.b]!);
  }
  const onFloor = new Set(
    contacts.filter((contact) => contact.floor).map((contact) => contact.body),
  );
  for (const [index, body] of bodies.entries()) {
    if (body.asleep) continue;
    body.position = add(body.position, scale(body.velocity, DT));
    const half = 0.5 * DT;
    const spin: Quat = [body.angular[0] * half, body.angular[1] * half, body.angular[2] * half, 0];
    const turn = multiply(spin, body.rotation);
    body.rotation = normalizeQuat([
      body.rotation[0] + turn[0],
      body.rotation[1] + turn[1],
      body.rotation[2] + turn[2],
      body.rotation[3] + turn[3],
    ]);
    body.velocity = scale(body.velocity, LINEAR_DAMPING);
    body.angular = scale(
      body.angular,
      onFloor.has(index) ? ANGULAR_DAMPING * ROLLING_DAMPING : ANGULAR_DAMPING,
    );
    if (body.ball && onFloor.has(index)) {
      const spin = length(body.angular);
      body.angular =
        spin > BALL_DRAG * DT ? scale(body.angular, 1 - (BALL_DRAG * DT) / spin) : [0, 0, 0];
    }
    const calm =
      dot(body.velocity, body.velocity) < SLEEP_SPEED2 &&
      dot(body.angular, body.angular) < SLEEP_SPIN2 &&
      onFloor.has(index) &&
      flatPose(body).dot >= FLAT;
    body.still = calm ? body.still + DT : 0;
    if (body.still >= SLEEP_SECONDS) {
      body.asleep = true;
      body.velocity = [0, 0, 0];
      body.angular = [0, 0, 0];
    }
  }
}

export type Simulation = {
  /** Runs until the performance.now() deadline, returning true when complete. */
  advance: (deadline: number) => boolean;
  result: () => Throw;
};

/** Pausing at different deadlines produces the same recorded frames. */
export function simulation(kinds: DieKind[], seed: number, launch?: DiceLaunch): Simulation {
  const bodies = spawn(kinds, seed);
  const die = bodies[0];
  if (launch !== undefined && bodies.length === 1 && die !== undefined) {
    die.position = [launch.x * FLICK_REACH_X, die.sphere + 0.9, launch.z * FLICK_REACH_Z];
    die.velocity = [launch.vx * FLICK_SPEED, 2, launch.vz * FLICK_SPEED];
  }
  const frames: number[][] = bodies.map(() => []);
  const record = () => {
    for (const [i, body] of bodies.entries()) frames[i]!.push(...body.position, ...body.rotation);
  };
  record();
  let frame = 0;
  const balls = bodies.filter((body) => body.ball).length;
  const cap = MAX_SECONDS * FPS + CROWD_FRAMES * Math.max(0, balls - CALM_BALLS);
  let settledAt = cap / FPS;
  let done = false;
  let snapped = 0;

  const finish = () => {
    const targets = bodies.map((body) => flatPose(body));
    snapped = targets.filter((target) => target.dot < FLAT).length;
    const from = bodies.map((body) => ({ position: body.position, rotation: body.rotation }));
    const easing = snapped > 0 ? SNAP_FRAMES : 1;
    for (let k = 1; k <= easing; k += 1) {
      const t = k / easing;
      for (const [i, body] of bodies.entries()) {
        body.rotation = blend(from[i]!.rotation, targets[i]!.rotation, t);
        body.position = add(scale(from[i]!.position, 1 - t), scale(targets[i]!.position, t));
      }
      record();
    }
    done = true;
  };

  return {
    advance(deadline) {
      while (!done) {
        frame += 1;
        for (let k = 0; k < SUBSTEPS; k += 1) step(bodies);
        record();
        if (bodies.every((body) => body.asleep)) settledAt = frame / FPS;
        if (bodies.every((body) => body.asleep) || frame >= cap) finish();
        else if (performance.now() >= deadline) return false;
      }
      return true;
    },
    result: () => ({
      frames: frames.map((f) => Float64Array.from(f)),
      settledAt,
      sizes: bodies.map((body) => body.size),
      snapped,
    }),
  };
}

export function simulate(kinds: DieKind[], seed: number): Throw {
  const run = simulation(kinds, seed);
  run.advance(Number.POSITIVE_INFINITY);
  return run.result();
}

export function hashThrow(thrown: Throw): string {
  const hash = Uint32Array.of(2_166_136_261);
  for (const frames of thrown.frames) {
    const words = new Uint32Array(frames.buffer, frames.byteOffset, frames.length * 2);
    for (const word of words) hash[0] = Math.imul(hash[0]! ^ word, 16_777_619);
  }
  return hash[0]!.toString(16).padStart(8, "0");
}
