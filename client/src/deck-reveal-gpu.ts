import * as finish from "@typegpu/kit/finish";
import * as frames from "@typegpu/kit/frames";
import * as images from "@typegpu/kit/images";
import * as web from "@typegpu/kit/web";
import { tgpu } from "typegpu";

async function loadPicture(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.blob();
}

export async function playDeckReveal(canvas: HTMLCanvasElement, src: string, signal: AbortSignal) {
  const started = performance.now();
  const [device, picture] = await Promise.allSettled([tgpu.init(), loadPicture(src, signal)]);
  if (device.status === "rejected") throw device.reason;
  const root = device.value;
  try {
    signal.throwIfAborted();
    if (picture.status === "rejected") throw picture.reason;
    const bitmap = await createImageBitmap(picture.value);
    const art = (() => {
      try {
        return images.create(root, bitmap, { mips: false });
      } finally {
        bitmap.close();
      }
    })();
    try {
      signal.throwIfAborted();
      using surface = web.surface(root, canvas);
      const final = finish.create(root, { format: surface.format, source: () => art, tone: null });
      using loop = frames.create(root, (frame) => {
        final.record(frame, surface.view(frame));
      });
      await final.initAsync();
      signal.throwIfAborted();
      if (performance.now() - started > 320) return;
      loop.run(0);
      const reveal = canvas.animate(
        [{ opacity: 0 }, { opacity: 0.35, filter: "brightness(1.09)" }, { opacity: 0 }],
        { duration: 260, easing: "ease-out" },
      );
      const cancel = () => reveal.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await reveal.finished;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } finally {
      art.destroy();
    }
  } finally {
    root.destroy();
  }
}
