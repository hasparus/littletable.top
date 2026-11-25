import { circle, circleVertexCount } from "@typegpu/kit/geometry";
import { readFile, writeFile } from "node:fs/promises";
import tgpu from "typegpu";

const vertexCount = circleVertexCount(4);
const template = `
struct Marker {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex fn vertex(@builtin(vertex_index) vertexId: u32, @builtin(instance_index) instance: u32) -> Marker {
  let slot = f32(instance % 6u);
  let filled = instance >= 6u;
  let center = vec2f(-1.0 + (slot + 0.5) / 3.0, 0.0);
  let point = kitCircle(vertexId) * vec2f(1.0 / 6.0, 1.0) * select(0.68, 0.53, filled);
  return Marker(vec4f(center + point, 0.0, 1.0), select(vec4f(0.78, 0.63, 0.50, 1.0), vec4f(0.55, 0.22, 0.12, 1.0), filled));
}

@fragment fn fragment(input: Marker) -> @location(0) vec4f {
  return input.color;
}
`;
const wgsl = tgpu.resolve({ template, externals: { kitCircle: circle }, names: "strict" });
const license = await readFile(
  new URL("node_modules/@typegpu/kit/LICENSE", import.meta.url),
  "utf8",
);
const output = new URL(
  "../../../client/public/research/gizmos/spotlight-shader.js",
  import.meta.url,
);
await writeFile(
  output,
  `export const vertexCount = ${vertexCount};\nexport const code = \`\n/*\n${license.trim()}\n*/\n${wgsl.trim()}\n\`;\n`,
);
