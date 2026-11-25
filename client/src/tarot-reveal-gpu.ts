import * as finish from "@typegpu/kit/finish";
import * as frames from "@typegpu/kit/frames";
import * as images from "@typegpu/kit/images";
import * as web from "@typegpu/kit/web";
import { tgpu } from "typegpu";

export async function playTarotReveal(canvas: HTMLCanvasElement, src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const root = await tgpu.init();
  try {
    signal.throwIfAborted();
    const bitmap = await images.decodeBitmap({ bytes, mimeType: "image/webp" });
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
      loop.run(0);
      const reveal = canvas.animate(
        [{ opacity: 0, filter: "brightness(1.35)" }, { opacity: 1 }, { opacity: 0 }],
        { duration: 540, easing: "ease-out" },
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
