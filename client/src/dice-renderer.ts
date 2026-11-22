// A WebGL2 renderer for dice only: one lit shader (key light, ambient, a
// procedural studio to reflect, a clearcoat highlight, numerals that look
// engraved) and a floor shadow made of the dice's projected, blurred
// silhouettes plus a contact blob under each. The output is transparent and
// premultiplied, so the board shows through.
//
// NOTE: nothing here feeds back into the throw, so trigonometry and pow are
// fine in the shaders; the frames come from dice-physics.ts alone.

import type { Quat, Vec } from "./dice-math";
import type { DieMesh } from "./dice-mesh";

import { TRAY_DEPTH, TRAY_WIDTH } from "./dice-physics";

// "low": one device pixel per CSS pixel, no blurred silhouettes, no clearcoat.
export type Tier = "full" | "low";
export type Rgb = [number, number, number];
export type Look = { body: Rgb; ink: Rgb };
export type Model = { atlas: HTMLCanvasElement; inradius: number; mesh: DieMesh; radius: number };
export type Pose = { model: Model; position: Vec; rotation: Quat };

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
const SHADOW_WIDTH = 256;
// The shadow covers the tray and this much around it.
const SHADOW_REACH = 2;
const LIGHT: Vec = [-0.3042, 0.8692, -0.3911];
const SHADOW_OPACITY = { dark: 0.65, light: 0.32 };
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
uniform mat4 uViewProj; uniform vec4 uQ; uniform vec3 uP;
out vec3 vPos; out vec3 vNor; out vec2 vUv;
${ROTATE}
void main() {
  vec3 w = rot(uQ, aPos) + uP;
  vPos = w; vNor = rot(uQ, aNor); vUv = aUv;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const DIE_FS = `
precision highp float;
in vec3 vPos; in vec3 vNor; in vec2 vUv;
uniform sampler2D uAtlas;
uniform vec3 uCam, uLight, uBody, uInk;
uniform float uRough, uCoat, uCoatRough, uBump;
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
  vec3 n = normalize(vNor);
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
  frag = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

// A die's silhouette as the key light throws it on the floor.
const SILHOUETTE_VS = `#version 300 es
in vec3 aPos;
uniform vec4 uQ; uniform vec3 uP; uniform vec3 uLight; uniform vec2 uHalf;
${ROTATE}
void main() {
  vec3 w = rot(uQ, aPos) + uP;
  vec3 f = w - uLight * (w.y / uLight.y);
  gl_Position = vec4(f.x / uHalf.x, -f.z / uHalf.y, 0.0, 1.0);
}`;
const SILHOUETTE_FS = `
precision highp float; uniform float uStrength; out vec4 frag;
void main() { frag = vec4(uStrength); }`;

const QUAD_VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const BLUR_FS = `
precision highp float; in vec2 vUv; uniform sampler2D uTex; uniform vec2 uStep; out vec4 frag;
void main() {
  float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
  float s = texture(uTex, vUv).r * w[0];
  for (int i = 1; i < 5; i++) {
    s += texture(uTex, vUv + uStep * float(i)).r * w[i];
    s += texture(uTex, vUv - uStep * float(i)).r * w[i];
  }
  frag = vec4(s);
}`;

// A quad lying on the floor: the whole shadow area, or one die's blob.
const FLOOR_VS = `#version 300 es
in vec2 aPos; uniform mat4 uViewProj; uniform vec2 uCenter; uniform vec2 uHalf;
out vec2 vLocal; out vec2 vUv;
void main() {
  vLocal = aPos;
  vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5;
  vec2 xz = uCenter + aPos * uHalf;
  gl_Position = uViewProj * vec4(xz.x, 0.0, xz.y, 1.0);
}`;
const SHADOW_FS = `
precision highp float; in vec2 vUv; uniform sampler2D uTex; uniform float uOpacity; out vec4 frag;
void main() { frag = vec4(0.0, 0.0, 0.0, clamp(texture(uTex, vUv).r * 0.75, 0.0, 1.0) * uOpacity); }`;
const BLOB_FS = `
precision highp float; in vec2 vLocal; uniform float uOpacity; out vec4 frag;
void main() {
  float fade = 1.0 - smoothstep(0.0, 1.0, length(vLocal));
  frag = vec4(0.0, 0.0, 0.0, fade * fade * uOpacity);
}`;

type Program = { program: WebGLProgram; uniform: (name: string) => WebGLUniformLocation | null };
type Target = { framebuffer: WebGLFramebuffer; texture: WebGLTexture };
type Uploaded = {
  atlas: WebGLTexture;
  count: number;
  die: WebGLVertexArrayObject;
  silhouette: WebGLVertexArrayObject;
};

// How far a die is off the floor.
const lift = (pose: Pose) => Math.max(0, pose.position[1] - pose.model.inradius);

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

// A camera above the tray, tilted a little toward the viewer, as one
// column-major view-projection matrix. `across` and `down` are the shares of
// the canvas the tray's rectangle takes, so the whole canvas is drawn on and
// a die in flight is not cut off at the tray's edge.
function camera(across: number, down: number, aspect: number) {
  const distance = (TRAY_DEPTH / 2 + MARGIN) / TAN_HALF_FOV;
  const eye: Vec = [0, distance, distance * CAMERA_TILT];
  const size = Math.hypot(...eye);
  const forward: Vec = [0, -eye[1] / size, -eye[2] / size];
  // With "up" along -z: right is +x, and the camera's own up follows.
  const up: Vec = [0, -forward[2], forward[1]];
  const near = 1;
  const far = 200;
  const sx = across / (TAN_HALF_FOV * aspect);
  const sy = down / TAN_HALF_FOV;
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
  const half: [number, number] = [
    TRAY_WIDTH / 2 + MARGIN + SHADOW_REACH,
    TRAY_DEPTH / 2 + MARGIN + SHADOW_REACH,
  ];
  const shadowHeight = Math.round(SHADOW_WIDTH * (half[1] / half[0]));
  const uploaded = new Map<Model, Uploaded>();
  let lost = false;

  const build = () => {
    const header = `#version 300 es\n${full ? "#define FULL\n" : ""}`;
    const quad = must(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const target = (): Target => {
      const texture = must(gl.createTexture(), "texture");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SHADOW_WIDTH, shadowHeight);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = must(gl.createFramebuffer(), "framebuffer");
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { framebuffer, texture };
    };
    return {
      blob: compile(gl, FLOOR_VS, header + BLOB_FS),
      die: compile(gl, DIE_VS, header + DIE_FS),
      quad,
      shadows: full
        ? {
            blur: compile(gl, QUAD_VS, header + BLUR_FS),
            floor: compile(gl, FLOOR_VS, header + SHADOW_FS),
            silhouette: compile(gl, SILHOUETTE_VS, header + SILHOUETTE_FS),
            targets: [target(), target()] as const,
          }
        : null,
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
    const silhouette = must(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(silhouette);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
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
    const made = { atlas, count: mesh.count, die, silhouette };
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

  const castShadows = (poses: Pose[], shadows: NonNullable<typeof gpu.shadows>) => {
    const [first, second] = shadows.targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, first.framebuffer);
    gl.viewport(0, 0, SHADOW_WIDTH, shadowHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    const { program, uniform } = shadows.silhouette;
    gl.useProgram(program);
    gl.uniform3fv(uniform("uLight"), LIGHT);
    gl.uniform2fv(uniform("uHalf"), half);
    for (const pose of poses) {
      const model = upload(pose.model);
      gl.bindVertexArray(model.silhouette);
      gl.uniform4fv(uniform("uQ"), pose.rotation);
      gl.uniform3fv(uniform("uP"), pose.position);
      gl.uniform1f(uniform("uStrength"), 1 / (1 + lift(pose) * 0.6));
      gl.drawArrays(gl.TRIANGLES, 0, model.count);
    }
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.useProgram(shadows.blur.program);
    gl.bindVertexArray(gpu.quad);
    for (const [from, to, x, y] of [
      [first, second, 1 / SHADOW_WIDTH, 0],
      [second, first, 0, 1 / shadowHeight],
      [first, second, 2 / SHADOW_WIDTH, 0],
      [second, first, 0, 2 / shadowHeight],
    ] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(shadows.blur.uniform("uStep"), x, y);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    gl.disable(gl.DEPTH_TEST);
    if (gpu.shadows !== null) castShadows(poses, gpu.shadows);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const tray = trayRect(width, height);
    const { eye, viewProj } = camera(
      tray.width / width,
      tray.height / height,
      tray.width / tray.height,
    );
    const opacity = dark ? SHADOW_OPACITY.dark : SHADOW_OPACITY.light;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(gpu.quad);
    if (gpu.shadows !== null) {
      const { program, uniform } = gpu.shadows.floor;
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniform("uViewProj"), false, viewProj);
      gl.uniform2f(uniform("uCenter"), 0, 0);
      gl.uniform2fv(uniform("uHalf"), half);
      gl.uniform1f(uniform("uOpacity"), opacity);
      gl.bindTexture(gl.TEXTURE_2D, gpu.shadows.targets[0].texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.useProgram(gpu.blob.program);
    gl.uniformMatrix4fv(gpu.blob.uniform("uViewProj"), false, viewProj);
    for (const pose of poses) {
      const [x, y, z] = pose.position;
      // Without the cast silhouettes the blob is the whole shadow: larger,
      // darker, and pushed away from the light as the die rises.
      const [reach, strength, shift] = full ? [1.05, 0.55, 0] : [1.3, 1.1, y * 0.45];
      const size = pose.model.radius * reach * (1 + lift(pose) * 0.3);
      gl.uniform2f(gpu.blob.uniform("uCenter"), x + shift * 0.8, z + shift);
      gl.uniform2f(gpu.blob.uniform("uHalf"), size, size);
      gl.uniform1f(gpu.blob.uniform("uOpacity"), (strength / (1 + lift(pose) * 1.5)) * opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);

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
    gl.uniform1f(uniform("uCoat"), MATERIAL.coat);
    gl.uniform1f(uniform("uCoatRough"), MATERIAL.coatRoughness);
    gl.uniform1f(uniform("uBump"), MATERIAL.bump);
    gl.uniform1i(uniform("uAtlas"), 0);
    for (const pose of poses) {
      const model = upload(pose.model);
      gl.bindVertexArray(model.die);
      gl.bindTexture(gl.TEXTURE_2D, model.atlas);
      gl.uniform4fv(uniform("uQ"), pose.rotation);
      gl.uniform3fv(uniform("uP"), pose.position);
      gl.drawArrays(gl.TRIANGLES, 0, model.count);
    }
    gl.disable(gl.CULL_FACE);
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
