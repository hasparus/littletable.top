// A WebGL2 renderer for dice only: one lit shader (key light, ambient, a
// procedural studio to reflect, a clearcoat highlight, numerals that look
// engraved) and floor shadows made of geometry alone. A die is convex, so
// its shadow is the convex outline of its corners as the light throws them
// on the floor, grown by its rounding. That outline is drawn as a mesh whose
// vertices carry how far through the penumbra they are: the penumbra is as
// wide as the corner that casts it is high, and the shadow as dark as that
// corner is low: crisp and darkest where the die touches the floor, soft and
// paler at its far end. One light, one shadow: nothing else shades the floor.
// The output is transparent and premultiplied, so the board shows through.
//
// NOTE: nothing here feeds back into the throw, so trigonometry and pow are
// fine in the shaders; the frames come from dice-physics.ts alone.

import type { DieMesh } from "./dice-mesh";

import { add, type Quat, rotate, scale, type Vec } from "./dice-math";
import { TRAY_DEPTH, TRAY_WIDTH } from "./dice-physics";

// "low": one device pixel per CSS pixel, no clearcoat.
export type Tier = "full" | "low";
export type Rgb = [number, number, number];
export type Look = { body: Rgb; ink: Rgb };
// `core` and `rounding`: the die is its core's corners swept by a ball.
// `coat`: its share of the clearcoat. `smooth`: how far its faces are lit
// as the sphere around them, which keeps one of a ball's many small faces
// from outshining the rest.
export type Model = {
  atlas: HTMLCanvasElement;
  coat: number;
  core: Vec[];
  mesh: DieMesh;
  rounding: number;
  smooth: number;
};
// `size`: the die as a share of its model.
export type Pose = {
  dimmed: number;
  model: Model;
  position: Vec;
  rotation: Quat;
  size: number;
};

export type Renderer = {
  dispose: () => void;
  draw: (poses: Pose[], dark: boolean) => void;
  tier: Tier;
};

// Room around the tray for the parts of a die that overhang its footprint.
const MARGIN = 0.4;
// tan(12°): a 24° lens, long enough that dice at the edges barely lean.
const TAN_HALF_FOV = 0.2126;
const CAMERA_TILT = 0.12;
const MAX_PIXEL_RATIO = 2;
// 64° up, from the far left.
const LIGHT: Vec = [-0.269, 0.8988, -0.3458];
// Shadow colours where a die touches the floor, not premultiplied: ink on a
// light board, black on a dark one.
const SHADOW_TINT = { dark: [0, 0, 0, 0.85], light: [0.07, 0.08, 0.17, 0.5] } as const;
// Penumbra width in floor units: at the floor, and more per unit of height.
const PENUMBRA = { atFloor: 0.05, perHeight: 0.22 };
// How quickly a shadow pales with the height of the corner that casts it
// above the die's lowest point, and with the height of the die off the floor.
const PALING = { lifted: 0.35, within: 0.5 };

const MATERIAL = { bump: 1.3, coat: 0.8, coatRoughness: 0.12, roughness: 0.42 };

// The tray's rectangle in a host of `width` by `height` CSS pixels: as large
// as fits with its aspect kept, centred. Every screen shows the whole tray,
// so a die lands on the same spot of it everywhere.
export function trayRect(width: number, height: number) {
  const across = TRAY_WIDTH + 2 * MARGIN;
  const down = TRAY_DEPTH + 2 * MARGIN;
  const pxPerUnit = Math.min(width / across, height / down);
  return {
    height: down * pxPerUnit,
    pxPerUnit,
    width: across * pxPerUnit,
    x: (width - across * pxPerUnit) / 2,
    y: (height - down * pxPerUnit) / 2,
  };
}

const ROTATE = `
vec3 rot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }`;

const DIE_VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec2 aUv;
uniform mat4 uViewProj; uniform vec4 uQ; uniform vec3 uP; uniform float uSize;
out vec3 vPos; out vec3 vNor; out vec2 vUv;
${ROTATE}
void main() {
  vec3 w = rot(uQ, aPos * uSize) + uP;
  vPos = w; vNor = rot(uQ, aNor); vUv = aUv;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const DIE_FS = `
precision highp float;
in vec3 vPos; in vec3 vNor; in vec2 vUv;
uniform sampler2D uAtlas;
uniform vec3 uCam, uLight, uBody, uInk;
uniform float uRough, uCoat, uCoatRough, uBump, uSmooth;
uniform float uDimmed;
uniform vec3 uP;
out vec4 frag;
const float PI = 3.14159265;
// A soft studio: a bright panel up and to the left, warm walls, a grey floor.
vec3 env(vec3 r, float rough) {
  float up = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(vec3(0.20, 0.19, 0.18), vec3(0.95, 0.95, 0.97), smoothstep(0.25, 0.9, up));
  float w = mix(0.04, 0.5, rough);
  float panel = smoothstep(1.0 - w * 1.6, 1.0 - w * 0.25, dot(r, normalize(vec3(-0.45, 1.0, -0.35))));
  float rim = smoothstep(0.92 - w, 1.0, dot(r, normalize(vec3(0.9, 0.35, 0.6)))) * 0.6;
  return base * 0.75 + panel * vec3(2.6) + rim * vec3(1.0, 0.96, 0.9);
}
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float schlick(float c) { return 0.04 + 0.96 * pow(1.0 - c, 5.0); }
void main() {
  float paper = texture(uAtlas, vUv).r;
  vec3 base = pow(mix(uInk, uBody, paper), vec3(2.2));
  vec3 n = normalize(mix(normalize(vNor), normalize(vPos - uP), uSmooth));
  // Engraved numerals: the normal leans along the ink's edge on screen.
  vec3 dpx = dFdx(vPos), dpy = dFdy(vPos);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 slope = sign(det) * (dFdx(paper) * r1 + dFdy(paper) * r2);
  n = normalize(abs(det) * n - uBump * 0.002 * slope);
  vec3 v = normalize(uCam - vPos);
  vec3 h = normalize(uLight + v);
  float nl = max(dot(n, uLight), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0);
  float a = uRough * uRough;
  float k = a * 0.5;
  float vis = 1.0 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k) * 4.0);
  float fresnel = schlick(nv);
  vec3 key = vec3(2.6) * nl;
  vec3 ambient = mix(vec3(0.30, 0.29, 0.28), vec3(0.85), n.y * 0.5 + 0.5) * 0.55;
  vec3 r = reflect(-v, n);
  vec3 col = base * (key / PI + ambient) * (1.0 - fresnel)
    + vec3(ggx(nh, a) * vis * schlick(dot(h, v))) * key * 0.9
    + env(r, uRough) * fresnel * 0.55;
#ifdef FULL
  float coat = fresnel * uCoat;
  float ac = uCoatRough * uCoatRough;
  col += vec3(ggx(nh, ac)) * key * coat + env(r, uCoatRough) * coat * 0.7;
#endif
  col = col / (1.0 + max(max(col.r, col.g), col.b) * 0.15);
  float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(gray * 0.55), uDimmed);
  frag = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

// The shadows of all dice as one mesh on the floor: x, z, how far through the
// fade from full shade (0) to none (1) the vertex is, and the shadow's
// strength there.
const SHADE_VS = `#version 300 es
in vec4 aPos; uniform mat4 uViewProj;
out vec2 vShade;
void main() {
  vShade = aPos.zw;
  gl_Position = uViewProj * vec4(aPos.x, 0.0, aPos.y, 1.0);
}`;
const SHADE_FS = `
precision highp float;
in vec2 vShade; uniform vec4 uTint;
out vec4 frag;
void main() { frag = uTint * (vShade.y * (1.0 - smoothstep(0.0, 1.0, vShade.x))); }`;

type Program = { program: WebGLProgram; uniform: (name: string) => WebGLUniformLocation | null };
type Uploaded = { atlas: WebGLTexture; count: number; die: WebGLVertexArrayObject };
type Point = [number, number];
type ScreenPoint = { x: number; y: number };

// The key light on the floor: the way shadows fall, how far per unit of
// height, and the sine of its elevation.
const SUN = (() => {
  const flat = Math.hypot(LIGHT[0], LIGHT[2]);
  return { lean: flat / LIGHT[1], squash: LIGHT[1], x: -LIGHT[0] / flat, z: -LIGHT[2] / flat };
})();

// The convex outline of `spots`, counter-clockwise (a monotone chain).
function hullOf<T extends ScreenPoint>(spots: T[]): T[] {
  const sorted = spots.toSorted((a, b) => a.x - b.x || a.y - b.y);
  const chain = (list: T[]) => {
    const kept: T[] = [];
    for (const p of list) {
      while (kept.length >= 2) {
        const o = kept.at(-2)!;
        const a = kept.at(-1)!;
        if ((a.x - o.x) * (p.y - o.y) - (a.y - o.y) * (p.x - o.x) > 1e-9) break;
        kept.pop();
      }
      kept.push(p);
    }
    kept.pop();
    return kept;
  };
  return [...chain(sorted), ...chain(sorted.toReversed())];
}

// Per edge of `outline`, its outward normal.
const normalsOf = (outline: ScreenPoint[]) =>
  outline.map(({ x, y }, index): Point => {
    const next = outline[(index + 1) % outline.length]!;
    const reach = Math.max(Math.hypot(next.x - x, next.y - y), 1e-6);
    return [(next.y - y) / reach, (x - next.x) / reach];
  });

// `outline` pushed out by `offset(spot)`, each corner as three points of its arc.
function grown<T extends ScreenPoint>(
  outline: T[],
  normals: Point[],
  offset: (spot: T) => number,
): Point[] {
  return outline.flatMap((spot, index) => {
    const before = normals[(index + outline.length - 1) % outline.length]!;
    const after = normals[index]!;
    const size = Math.max(Math.hypot(before[0] + after[0], before[1] + after[1]), 1e-6);
    const middle: Point = [(before[0] + after[0]) / size, (before[1] + after[1]) / size];
    const out = offset(spot);
    return [before, middle, after].map(([nx, ny]): Point => [spot.x + nx * out, spot.y + ny * out]);
  });
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`dice: WebGL gave no ${what}`);
  return value;
}

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const program = must(gl.createProgram(), "program");
  const shaders = ([gl.VERTEX_SHADER, gl.FRAGMENT_SHADER] as const).map((type, index) => {
    const shader = must(gl.createShader(type), "shader");
    gl.shaderSource(shader, index === 0 ? vertex : fragment);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    return shader;
  });
  gl.bindAttribLocation(program, 0, "aPos");
  gl.bindAttribLocation(program, 1, "aNor");
  gl.bindAttribLocation(program, 2, "aUv");
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true && !gl.isContextLost()) {
    const logs = [gl.getProgramInfoLog(program), ...shaders.map((s) => gl.getShaderInfoLog(s))];
    throw new Error(`dice: shader did not link: ${logs.join(" ")}`);
  }
  const locations = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform: (name) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name) ?? null;
    },
  };
}

const EYE_HEIGHT = (TRAY_DEPTH / 2 + MARGIN) / TAN_HALF_FOV;
// Where the tray is seen from.
export const EYE: Vec = [0, EYE_HEIGHT, EYE_HEIGHT * CAMERA_TILT];

// A camera above the tray, tilted a little toward the viewer, as one
// column-major view-projection matrix. `across` and `down` are the shares of
// the canvas the tray's rectangle takes, so the whole canvas is drawn on and
// a die in flight is not cut off at the tray's edge.
function camera(width: number, height: number) {
  const tray = trayRect(width, height);
  const eye = EYE;
  const size = Math.hypot(...eye);
  const forward: Vec = [0, -eye[1] / size, -eye[2] / size];
  // With "up" along -z: right is +x, and the camera's own up follows.
  const up: Vec = [0, -forward[2], forward[1]];
  const near = 1;
  const far = 200;
  const sx = tray.height / (width * TAN_HALF_FOV);
  const sy = tray.height / (height * TAN_HALF_FOV);
  const depth = (far + near) / (near - far);
  const along = (axis: Vec) => -(axis[1] * eye[1] + axis[2] * eye[2]);
  // Rows of the view matrix: right (1 0 0), up, -forward; then the projection.
  const viewProj = new Float32Array([
    sx,
    0,
    0,
    0,
    0,
    sy * up[1],
    -depth * forward[1],
    forward[1],
    0,
    sy * up[2],
    -depth * forward[2],
    forward[2],
    0,
    sy * along(up),
    depth * -along(forward) + (2 * far * near) / (near - far),
    along(forward),
  ]);
  return { eye, viewProj };
}

// The same projection drives the canvas and the interactive silhouette of
// each die. Projecting the rounded outline leaves the board usable between
// dice, even when there are several in the tray.
export function diceScreen(width: number, height: number) {
  const { viewProj: m } = camera(width, height);
  const project = ([x, y, z]: Vec): ScreenPoint => {
    const w = m[7]! * y + m[11]! * z + m[15]!;
    return {
      x: ((1 + (m[0]! * x) / w) * width) / 2,
      y: ((1 - (m[5]! * y + m[9]! * z + m[13]!) / w) * height) / 2,
    };
  };
  return {
    atHeight({ x, y }: ScreenPoint, up: number): Vec {
      const across = (2 * x) / width - 1;
      const down = 1 - (2 * y) / height;
      const base = m[7]! * up + m[15]!;
      const depth = (m[5]! * up + m[13]! - down * base) / (down * m[11]! - m[9]!);
      return [(across * (base + m[11]! * depth)) / m[0]!, up, depth];
    },
    outline(pose: Pose): Point[] {
      const { model, position, rotation, size } = pose;
      const corners = model.core.map((corner) =>
        project(add(position, rotate(rotation, scale(corner, size)))),
      );
      const hull = hullOf(corners);
      const pad = project(add(position, [model.rounding * size, 0, 0])).x - project(position).x;
      return grown(hull, normalsOf(hull), () => pad + 1);
    },
    project,
  };
}

// Software rendering, or a device that reports little memory or few cores,
// gets the low tier: the same throw, drawn more cheaply.
function contextOf(canvas: HTMLCanvasElement, forced: Tier | null) {
  const attributes: WebGLContextAttributes = {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  };
  const fast = canvas.getContext("webgl2", { ...attributes, failIfMajorPerformanceCaveat: true });
  const gl = fast ?? canvas.getContext("webgl2", attributes);
  if (gl === null) throw new Error("dice: WebGL2 is not available");
  const { deviceMemory } = navigator as { deviceMemory?: number };
  const weak =
    fast === null ||
    navigator.hardwareConcurrency <= 2 ||
    (deviceMemory !== undefined && deviceMemory <= 2) ||
    (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) < 4096;
  const tier: Tier = forced ?? (weak ? "low" : "full");
  return { gl, tier };
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  { look, onRestored, tier: forced }: { look: Look; onRestored: () => void; tier: Tier | null },
): Renderer {
  const { gl, tier } = contextOf(canvas, forced);
  const full = tier === "full";
  const uploaded = new Map<Model, Uploaded>();
  // The shades' vertices, four numbers each; it grows to hold a throw.
  let shades = new Float32Array(1 << 14);
  let shadesUsed = 0;
  let lost = false;

  const build = () => {
    const header = `#version 300 es\n${full ? "#define FULL\n" : ""}`;
    const mesh = must(gl.createVertexArray(), "vertex array");
    const buffer = must(gl.createBuffer(), "buffer");
    gl.bindVertexArray(mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    return {
      die: compile(gl, DIE_VS, header + DIE_FS),
      shade: { ...compile(gl, SHADE_VS, header + SHADE_FS), buffer, mesh },
    };
  };
  let gpu = build();

  const upload = (model: Model): Uploaded => {
    const known = uploaded.get(model);
    if (known !== undefined) return known;
    const { mesh } = model;
    const die = must(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(die);
    for (const [index, data] of [mesh.positions, mesh.normals, mesh.uvs].entries()) {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, index === 2 ? 2 : 3, gl.FLOAT, false, 0, 0);
    }
    const atlas = must(gl.createTexture(), "texture");
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, model.atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
    if (anisotropy !== null) {
      gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    }
    const made = { atlas, count: mesh.count, die };
    uploaded.set(model, made);
    return made;
  };

  const onLost = (event: Event) => {
    // NOTE: without this the browser never restores the context.
    event.preventDefault();
    lost = true;
  };
  const onRestore = () => {
    uploaded.clear();
    gpu = build();
    lost = false;
    onRestored();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestore);

  // Adds rings of points as triangles: ring 0 to ring 1, ring 1 to ring 2.
  // `place` turns a ring's point into a floor point; `fades[r]` is how far
  // through the fade ring r is, `strengths[r][i]` the shadow's strength at
  // its point i.
  const band = (
    rings: Point[][],
    fades: number[],
    strengths: number[][],
    place: (point: Point) => Point,
  ) => {
    const count = rings[0]!.length;
    const needed = shadesUsed + (rings.length - 1) * count * 24;
    if (needed > shades.length) {
      const larger = new Float32Array(Math.max(needed, shades.length * 2));
      larger.set(shades);
      shades = larger;
    }
    const placed = rings.map((ring) => ring.map(place));
    for (let ring = 0; ring + 1 < rings.length; ring += 1)
      for (let index = 0; index < count; index += 1) {
        const next = (index + 1) % count;
        for (const [r, i] of [
          [ring, index],
          [ring + 1, index],
          [ring + 1, next],
          [ring, index],
          [ring + 1, next],
          [ring, next],
        ] as const) {
          const [x, z] = placed[r]![i]!;
          shades[shadesUsed] = x;
          shades[shadesUsed + 1] = z;
          shades[shadesUsed + 2] = fades[r]!;
          shades[shadesUsed + 3] = strengths[r]![i]!;
          shadesUsed += 4;
        }
      }
  };

  // One die's cast shadow, built in the sun's space: the floor turned so
  // that x runs away from the light and squashed along it by the sine of the
  // light's elevation, which makes the shadow of the die's rounding a circle
  // again. From its middle to its outline, then out through half the penumbra.
  const cast = (corners: Vec[], rounding: number, bottom: number) => {
    const outline = hullOf(
      corners.map(([x, y, z]) => ({
        soft: PENUMBRA.atFloor + PENUMBRA.perHeight * (y - rounding),
        strength:
          1 / ((1 + PALING.lifted * bottom) * (1 + PALING.within * (y - rounding - bottom))),
        x: (x * SUN.x + z * SUN.z + y * SUN.lean) * SUN.squash,
        y: z * SUN.x - x * SUN.z,
      })),
    );
    const normals = normalsOf(outline);
    const share = 1 / outline.length;
    let [x, y, soft, strength] = [0, 0, 0, 0];
    for (const spot of outline) {
      x += spot.x * share;
      y += spot.y * share;
      soft += spot.soft * share;
      strength += spot.strength * share;
    }
    const strengths = outline.flatMap((spot) => [spot.strength, spot.strength, spot.strength]);
    const depth =
      rounding +
      Math.min(
        ...outline.map((spot, index) => {
          const [nx, ny] = normals[index]!;
          return (spot.x - x) * nx + (spot.y - y) * ny;
        }),
      );
    band(
      [
        outline.flatMap((): Point[] => [
          [x, y],
          [x, y],
          [x, y],
        ]),
        grown(outline, normals, () => rounding),
        grown(outline, normals, (spot) => rounding + spot.soft / 2),
      ],
      [0.5 - depth / soft, 0.5, 1],
      [strengths.map(() => strength), strengths, strengths],
      ([along, across]) => [
        (SUN.x * along) / SUN.squash - SUN.z * across,
        (SUN.z * along) / SUN.squash + SUN.x * across,
      ],
    );
  };

  const draw = (poses: Pose[], dark: boolean) => {
    if (lost) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const ratio = full ? Math.min(globalThis.devicePixelRatio, MAX_PIXEL_RATIO) : 1;
    const pixels = [Math.round(width * ratio), Math.round(height * ratio)] as const;
    if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
      [canvas.width, canvas.height] = pixels;
    }
    gl.activeTexture(gl.TEXTURE0);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { eye, viewProj } = camera(width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    const { program, uniform } = gpu.die;
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniform("uViewProj"), false, viewProj);
    gl.uniform3fv(uniform("uCam"), eye);
    gl.uniform3fv(uniform("uLight"), LIGHT);
    gl.uniform3fv(uniform("uBody"), look.body);
    gl.uniform3fv(uniform("uInk"), look.ink);
    gl.uniform1f(uniform("uRough"), MATERIAL.roughness);
    gl.uniform1f(uniform("uCoatRough"), MATERIAL.coatRoughness);
    gl.uniform1f(uniform("uBump"), MATERIAL.bump);
    gl.uniform1i(uniform("uAtlas"), 0);
    for (const pose of poses) {
      const model = upload(pose.model);
      gl.bindVertexArray(model.die);
      gl.bindTexture(gl.TEXTURE_2D, model.atlas);
      gl.uniform4fv(uniform("uQ"), pose.rotation);
      gl.uniform3fv(uniform("uP"), pose.position);
      gl.uniform1f(uniform("uSize"), pose.size);
      gl.uniform1f(uniform("uDimmed"), pose.dimmed);
      gl.uniform1f(uniform("uCoat"), MATERIAL.coat * pose.model.coat);
      gl.uniform1f(uniform("uSmooth"), pose.model.smooth);
      gl.drawArrays(gl.TRIANGLES, 0, model.count);
    }
    gl.disable(gl.CULL_FACE);

    // NOTE: after the dice and behind them in depth, so the floor under a die
    // costs no shading.
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    const [red, green, blue, alpha] = dark ? SHADOW_TINT.dark : SHADOW_TINT.light;
    const shaded = poses.map((pose) => {
      const corners = pose.model.core.map((corner) =>
        add(rotate(pose.rotation, scale(corner, pose.size)), pose.position),
      );
      const rounding = pose.model.rounding * pose.size;
      const bottom = Math.max(0, Math.min(...corners.map((corner) => corner[1])) - rounding);
      return { bottom, corners, rounding };
    });

    shadesUsed = 0;
    for (const { bottom, corners, rounding } of shaded) cast(corners, rounding, bottom);
    gl.useProgram(gpu.shade.program);
    gl.bindVertexArray(gpu.shade.mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.shade.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, shades, gl.DYNAMIC_DRAW, 0, shadesUsed);
    gl.uniformMatrix4fv(gpu.shade.uniform("uViewProj"), false, viewProj);
    gl.uniform4f(gpu.shade.uniform("uTint"), red * alpha, green * alpha, blue * alpha, alpha);
    // NOTE: one light, so where two shadows overlap the floor is no darker
    // than under one.
    gl.blendEquation(gl.MAX);
    gl.drawArrays(gl.TRIANGLES, 0, shadesUsed / 4);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  };

  return {
    dispose: () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestore);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
    draw,
    tier,
  };
}
