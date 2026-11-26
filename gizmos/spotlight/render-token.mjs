import { circle, circleVertexCount } from "@typegpu/kit/geometry";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import tgpu from "typegpu";

const size = 256;
const template = `
struct Face {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Face {
  let uv = kitCircle(index);
  return Face(vec4f(uv * 0.98, 0., 1.), uv);
}
fn relief(p: vec2f) -> f32 {
  let r = length(p);
  let angle = atan2(p.y + 0.00001, p.x);
  let rays = cos(angle * 8.);
  let star = 0.29 + 0.32 * pow(max(rays, 0.), 1.4);
  let engraving = smoothstep(star - 0.035, star + 0.015, r);
  let ridge = 1. - smoothstep(0.005, 0.026, abs(r - 0.73));
  let rim = 1. - smoothstep(0.005, 0.035, abs(r - 0.915));
  let reeding = smoothstep(0.76, 0.805, r) * (1. - smoothstep(0.85, 0.88, r)) * cos(angle * 74.);
  return 0.075 * (1. - r * r) + 0.04 * (1. - engraving) + 0.024 * ridge + 0.045 * rim
    + 0.011 * reeding - 0.07 * smoothstep(0.93, 1., r);
}
@fragment fn fragment(input: Face) -> @location(0) vec4f {
  let p = input.uv;
  let r = length(p);
  let h = relief(p);
  let d = 0.008;
  let n = normalize(vec3f(h - relief(p + vec2f(d, 0.)), h - relief(p + vec2f(0., d)), d));
  let light = normalize(vec3f(-0.52, 0.74, 0.65));
  let facet = pow(max(dot(reflect(-light, n), vec3f(0., 0., 1.)), 0.), 12.);
  let lit = clamp(0.18 + 0.75 * dot(n, light) + 0.38 * facet, 0., 1.);
  let grain = fract(sin(dot(floor(p * 154.), vec2f(39.39, 71.23))) * 438.65) * 0.025;
  var brass = mix(vec3f(0.23, 0.115, 0.055), vec3f(1., 0.84, 0.49), lit + grain);
  let a = atan2(p.y + 0.00001, p.x);
  let starR = 0.29 + 0.32 * pow(max(cos(a * 8.), 0.), 1.4);
  if (r < starR - 0.025) {
    let facetSide = smoothstep(-0.08, 0.08, sin(8. * a)) * 0.15 + 0.05 * cos(a);
    brass = mix(brass, vec3f(1., 0.91, 0.64), 0.2 + facetSide);
  }
  return vec4f(brass, 1.);
}`;
const module = tgpu.resolve({ template, externals: { kitCircle: circle } });
const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  await page.route("https://spotlight.test/", (route) =>
    route.fulfill({ body: "<!doctype html>" }),
  );
  await page.goto("https://spotlight.test/");
  const uri = await page.evaluate(
    async ({ module, vertexCount, size }) => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      try {
        const shader = device.createShaderModule({ code: module });
        const pipeline = await device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module: shader, entryPoint: "vertex" },
          fragment: { module: shader, entryPoint: "fragment", targets: [{ format: "rgba8unorm" }] },
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
        return canvas.toDataURL("image/webp", 0.96);
      } finally {
        device.destroy();
      }
    },
    { module, vertexCount: circleVertexCount(7), size },
  );
  await writeFile(new URL("token.webp", import.meta.url), Buffer.from(uri.split(",")[1], "base64"));
} finally {
  await browser.close();
}
