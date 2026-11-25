export const vertexCount = 138;
export const code = `
/*
MIT License

Copyright (c) 2026 Software Mansion <swmansion.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
struct SubdivLevelResult {
  level: u32,
  pointCount: u32,
  vertexCountInLevel: u32,
  vertexIndexInLevel: u32,
}

fn getSubdivLevel(vertexIndex: u32) -> SubdivLevelResult {
  var totalVertexCount = 0u;
  for (var level = 0u; (level < 8u); level += 1u) {
    let pointCount = (3u * (1u << level));
    let triangleCount = select(1u, u32((3 * (1 << (level - 1u)))), (level > 0u));
    let vertexCountInLevel = (3u * triangleCount);
    let newVertexCount = (totalVertexCount + vertexCountInLevel);
    if ((vertexIndex < newVertexCount)) {
      return SubdivLevelResult(level, pointCount, vertexCountInLevel, (vertexIndex - totalVertexCount));
    }
    totalVertexCount = newVertexCount;
  }
  return SubdivLevelResult(0u, 0u, 0u, 0u);
}

fn consecutiveTriangleVertexIndex(i: u32) -> u32 {
  return u32((f32((2u * (i + 1u))) / 3f));
}

const PI: f32 = 3.141592653589793f;

fn circle(vertexIndex: u32) -> vec2f {
  let subdiv = getSubdivLevel(vertexIndex);
  let i = consecutiveTriangleVertexIndex(subdiv.vertexIndexInLevel);
  let pointCount = subdiv.pointCount;
  let angle = (((2f * PI) * f32(i)) / f32(pointCount));
  return vec2f(cos(angle), sin(angle));
}
struct Marker {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex fn vertex(@builtin(vertex_index) vertexId: u32, @builtin(instance_index) instance: u32) -> Marker {
  let slot = f32(instance % 6u);
  let filled = instance >= 6u;
  let center = vec2f(-1.0 + (slot + 0.5) / 3.0, 0.0);
  let point = circle(vertexId) * vec2f(1.0 / 6.0, 1.0) * select(0.68, 0.53, filled);
  return Marker(vec4f(center + point, 0.0, 1.0), select(vec4f(0.78, 0.63, 0.50, 1.0), vec4f(0.55, 0.22, 0.12, 1.0), filled));
}

@fragment fn fragment(input: Marker) -> @location(0) vec4f {
  return input.color;
}
`;
