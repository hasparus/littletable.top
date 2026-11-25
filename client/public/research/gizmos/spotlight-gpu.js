import { code, vertexCount } from "./spotlight-shader.js";
export async function showSpotlightClock(canvas, ticks, currentPressure) {
  const adapter = await navigator.gpu?.requestAdapter();
  const context = canvas.getContext("webgpu");
  if (!adapter || !context) return;

  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  function restoreTicks() {
    canvas.hidden = true;
    ticks.hidden = false;
    canvas.removeEventListener("pressurechange", draw);
    context.unconfigure();
    device.destroy();
  }
  function draw() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(vertexCount, 6);
    pass.draw(vertexCount, currentPressure(), 0, 6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  let pipeline;
  try {
    const module = device.createShaderModule({ code });
    pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module, entryPoint: "vertex" },
      fragment: { module, entryPoint: "fragment", targets: [{ format }] },
    });
    context.configure({ device, format, alphaMode: "premultiplied" });
    draw();
    canvas.hidden = false;
    ticks.hidden = true;
    canvas.addEventListener("pressurechange", draw);
    device.lost.then(restoreTicks);
    device.addEventListener("uncapturederror", restoreTicks, { once: true });
  } catch (error) {
    restoreTicks();
    throw error;
  }
}
