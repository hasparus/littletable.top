// Bake the fader cap with TypeGPU Kit geometry and a height-field shader.
// Run with Node from any directory after installing project dependencies.
import { circle, circleVertexCount } from "@typegpu/kit/geometry";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import tgpu from "typegpu";

const size = 256;
const template = `
struct Face {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex(@builtin(vertex_index) index: u32) -> Face {
  let uv = kitCircle(index);
  return Face(vec4f(uv, 0., 1.), uv);
}

fn bevel(p: vec2f) -> f32 {
  let q = abs(p) - vec2f(0.73, 0.35);
  return length(max(q, vec2f(0.))) + min(max(q.x, q.y), 0.) - 0.085;
}

fn relief(p: vec2f) -> f32 {
  let slope = smoothstep(-0.01, 0.11, -bevel(p));
  let grip = smoothstep(0.1, 0.18, abs(p.y)) * (1. - smoothstep(0.31, 0.38, abs(p.y)));
  let teeth = abs(fract(p.x * 13.) - 0.5);
  let witness = 1. - smoothstep(0.014, 0.037, abs(p.y));
  return slope * (0.14 - 0.024 * grip * teeth - 0.02 * witness);
}

@fragment fn fragment(input: Face) -> @location(0) vec4f {
  let p = input.uv;
  let edge = bevel(p);
  let alpha = 1. - smoothstep(-0.012, 0.005, edge);
  if (alpha == 0.) { discard; }
  let d = 0.009;
  let h = relief(p);
  let normal = normalize(vec3f(h - relief(p + vec2f(d, 0.)), h - relief(p + vec2f(0., d)), d));
  let light = normalize(vec3f(-0.35, 0.65, 0.72));
  let shine = pow(max(dot(reflect(-light, normal), vec3f(0., 0., 1.)), 0.), 12.);
  let brushed = sin(238. * p.x + 2. * sin(94. * p.y)) * 0.022;
  let lit = clamp(0.15 + 0.76 * dot(normal, light) + 0.38 * shine + brushed, 0., 1.);
  let alloy = mix(vec3f(0.17, 0.20, 0.19), vec3f(0.91, 0.93, 0.86), lit);
  let darkMark = 1. - smoothstep(0.013, 0.025, abs(p.y));
  return vec4f(mix(alloy, vec3f(0.22, 0.24, 0.22), darkMark * 0.88), alpha);
}`;

const shader = tgpu.resolve({ template, externals: { kitCircle: circle } });
const browser = await chromium.launch({
  chromiumSandbox: false,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
  ],
});
try {
  const page = await browser.newPage();
  await page.route("http://127.0.0.1:35395/", (route) =>
    route.fulfill({ body: "<!doctype html>", contentType: "text/html" }),
  );
  await page.goto("http://127.0.0.1:35395/");
  const png = await page.evaluate(
    async ({ shader, vertexCount, size }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error("WebGPU adapter unavailable");
      const device = await adapter.requestDevice();
      try {
        const module = device.createShaderModule({ code: shader });
        const pipeline = await device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module, entryPoint: "vertex" },
          fragment: { module, entryPoint: "fragment", targets: [{ format: "rgba8unorm" }] },
        });
        const texture = device.createTexture({
          size: [size, size],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const buffer = device.createBuffer({
          size: size * size * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const commands = device.createCommandEncoder();
        const pass = commands.beginRenderPass({
          colorAttachments: [
            {
              view: texture.createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.draw(vertexCount);
        pass.end();
        commands.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: size * 4 }, [size, size]);
        device.queue.submit([commands.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const pixels = new Uint8ClampedArray(buffer.getMappedRange());
        canvas.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);
        buffer.unmap();
        return canvas.toDataURL("image/png");
      } finally {
        device.destroy();
      }
    },
    { shader, vertexCount: circleVertexCount(7), size },
  );
  const asset = await sharp(Buffer.from(png.split(",")[1], "base64"))
    .extract({ left: 20, top: 69, width: 216, height: 118 })
    .resize(144)
    .webp({ quality: 92 })
    .toBuffer();
  await writeFile(new URL("cap.webp", import.meta.url), asset);
} finally {
  await browser.close();
}
