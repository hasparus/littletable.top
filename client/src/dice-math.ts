// WARNING: Keep shared throws bit-identical. Use only +, -, *, / and Math.sqrt, abs, min, max, floor and imul.

export type Vec = [number, number, number];
// x, y, z, w
export type Quat = [number, number, number, number];

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec): Vec => scale(a, 1 / length(a));
export const lerp = (a: Vec, b: Vec, t: number): Vec => add(scale(a, 1 - t), scale(b, t));

export function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const quatDot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export function normalizeQuat(q: Quat): Quat {
  const size = Math.sqrt(quatDot(q, q));
  return [q[0] / size, q[1] / size, q[2] / size, q[3] / size];
}

export function rotate(q: Quat, v: Vec): Vec {
  const axis: Vec = [q[0], q[1], q[2]];
  const t = scale(cross(axis, v), 2);
  return add(add(v, scale(t, q[3])), cross(axis, t));
}

// The shortest rotation taking unit `from` onto unit `to` (not opposite).
export function rotationBetween(from: Vec, to: Vec): Quat {
  const c = cross(from, to);
  return normalizeQuat([c[0], c[1], c[2], 1 + dot(from, to)]);
}

// Normalised lerp: a stand-in for slerp that needs no trigonometry.
export function blend(a: Quat, b: Quat, t: number): Quat {
  const sign = quatDot(a, b) < 0 ? -1 : 1;
  return normalizeQuat([
    a[0] * (1 - t) + b[0] * sign * t,
    a[1] * (1 - t) + b[1] * sign * t,
    a[2] * (1 - t) + b[2] * sign * t,
    a[3] * (1 - t) + b[3] * sign * t,
  ]);
}

// The rotation whose matrix has columns x, y, z.
export function fromBasis(x: Vec, y: Vec, z: Vec): Quat {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(y[2] - z[1]) * s, (z[0] - x[2]) * s, (x[1] - y[0]) * s, 0.25 / s];
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]);
    return [0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  }
  if (y[1] > z[2]) {
    const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]);
    return [(y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s, (x[1] - y[0]) / s];
}

// xorshift32: integer steps, then one exact division into [0, 1). The
// typed array keeps the state an unsigned 32-bit integer.
export function generator(seed: number): () => number {
  const state = Uint32Array.of(seed);
  if (state[0] === 0) state[0] = 2_654_435_769;
  return () => {
    state[0] ^= state[0]! << 13;
    state[0] ^= state[0]! >>> 17;
    state[0] ^= state[0]! << 5;
    return state[0]! / 4_294_967_296;
  };
}

// A uniformly random rotation, by rejection inside the unit 4-ball.
export function randomRotation(random: () => number): Quat {
  for (;;) {
    const q: Quat = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    const size2 = quatDot(q, q);
    if (size2 > 0.01 && size2 <= 1) return normalizeQuat(q);
  }
}
