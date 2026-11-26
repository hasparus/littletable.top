import { create } from "@typegpu/kit/baker";
import { d, tgpu } from "typegpu";

const texel = tgpu.fn(
  [d.vec2f, d.u32],
  d.vec4f,
)(`(uv: vec2f, layer: u32) -> vec4f {
  let pixel = vec2u(uv * vec2f(64., 96.));
  var grain = (pixel.x % 8u) * 1459637u + (pixel.y % 8u) * 144269u;
  grain ^= grain >> 16u;
  grain *= 2246822519u;
  let fiber = f32(grain & 15u) / 15.;
  let distance = abs(uv.x * .66 + uv.y * .34 - .49);
  let soft = 1. - smoothstep(.02, .245, distance);
  let ridge = 1. - smoothstep(.0, .044, distance);
  let strength = (.13 * soft + .13 * ridge) * (.95 + .05 * fiber);
  return vec4f(1., .954, .806, strength);
}`);

export async function bake() {
  // WARNING: Readback requires the RGBA row to fit WebGPU’s 256-byte copy alignment.
  const width = 64;
  const height = 96;
  const root = await tgpu.init();
  try {
    const sheet = root
      .createTexture({ size: [width, height], format: "rgba8unorm" })
      .$usage("storage");
    const baking = create(root, sheet, { texel });
    await baking.initAsync();
    const encoder = root.createCommandEncoder();
    baking.record(encoder);
    encoder.submit();

    const { device } = root;
    const pixels = device.createBuffer({
      size: width * height * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const copy = device.createCommandEncoder();
    copy.copyTextureToBuffer(
      { texture: root.unwrap(sheet) },
      { buffer: pixels, bytesPerRow: width * 4 },
      [width, height],
    );
    device.queue.submit([copy.finish()]);
    await pixels.mapAsync(GPUMapMode.READ);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")
      .putImageData(
        new ImageData(new Uint8ClampedArray(pixels.getMappedRange()), width, height),
        0,
        0,
      );
    pixels.unmap();
    pixels.destroy();
    return canvas.toDataURL("image/webp", 0.72);
  } finally {
    root.destroy();
  }
}
