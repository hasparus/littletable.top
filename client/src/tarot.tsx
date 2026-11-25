import type { Editor } from "tldraw";

import { useEffect, useRef, useState } from "react";

import type { PassKeeper } from "./bootstrap";

import { TAROT_HEIGHT, tarotImage, tarotReveal, type TarotReveal } from "../../src/tarot-cards";
import { fill } from "./copy";
import { Sheet } from "./sheet";
import { useBoardUi } from "./ui";

const SCAN_COLLECTION =
  "https://commons.wikimedia.org/wiki/Category:Rider-Waite_tarot_deck_(Roses_%26_Lilies)";

export function useTarotDraw(keeper: PassKeeper) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState<TarotReveal | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);

  async function draw(editor: Editor, locale: string) {
    if (busy || editor.getIsReadonly()) return;
    const id = retryId ?? crypto.randomUUID();
    const bounds = editor.getViewportPageBounds();
    const { x, y } = bounds.center;
    const height = Math.max(1, Math.min(bounds.height * 0.46, 270 / editor.getZoomLevel()));
    setBusy(true);
    setFailed(false);
    setRevealed(null);
    try {
      const response = await fetch(`${keeper.room}/tarot`, {
        body: JSON.stringify({
          height,
          id,
          language: locale === "pl" ? "pl" : "en",
          page: editor.getCurrentPageId(),
          x,
          y,
        }),
        headers: {
          Authorization: `Bearer ${await keeper.pass()}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (response.status === 403) {
        keeper.end("link-reset");
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      const reveal: unknown = await response.json();
      if (!tarotReveal.isValid(reveal)) throw new Error("Invalid tarot reveal");
      setRetryId(null);
      setRevealed(reveal);
    } catch {
      setRetryId(id);
      setFailed(true);
      return;
    } finally {
      setBusy(false);
    }
  }

  return { busy, draw, failed, revealed };
}

export function TarotSheet({
  online,
  tarot,
}: {
  online: boolean;
  tarot: ReturnType<typeof useTarotDraw>;
}) {
  const { copy, editor, locale } = useBoardUi();
  return (
    <Sheet panel="tarot" title={copy.tarot}>
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">Rider–Waite–Smith · 1909</p>
          <p className="text-sm text-foreground-muted">{copy.tarotDescription}</p>
        </div>
        {tarot.revealed !== null && <CardPreview reveal={tarot.revealed} />}
        <button
          className="min-h-11 w-full rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus disabled:opacity-50"
          data-autofocus
          disabled={!online || editor === null || tarot.busy}
          onClick={async () => {
            if (editor !== null) await tarot.draw(editor, locale);
          }}
          type="button"
        >
          {tarot.busy ? copy.tarotDrawing : copy.tarotDraw}
        </button>
        {tarot.failed && (
          <p className="text-sm text-foreground" role="alert">
            {copy.tarotDrawFailed}
          </p>
        )}
        <p className="text-xs text-foreground-muted">
          <a
            className="rounded-sm underline focus-visible:outline-2 focus-visible:outline-border-focus"
            href={SCAN_COLLECTION}
            rel="noreferrer"
            target="_blank"
          >
            {copy.tarotCredits}
          </a>
        </p>
      </div>
    </Sheet>
  );
}

function CardPreview({ reveal }: { reveal: TarotReveal }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const src = tarotImage(reveal.card);
  useEffect(() => {
    const surface = canvas.current;
    if (
      surface === null ||
      !("gpu" in navigator) ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const lifetime = new AbortController();
    void import("./tarot-reveal-gpu")
      .then(({ playTarotReveal }) => playTarotReveal(surface, src, lifetime.signal))
      .catch(() => undefined);
    return () => lifetime.abort();
  }, [src]);

  return (
    <figure className="flex items-center gap-3 rounded-xl bg-bg-tertiary p-2">
      <div
        className="relative h-28 shrink-0 overflow-hidden rounded-sm"
        style={{ aspectRatio: reveal.width / TAROT_HEIGHT }}
      >
        <img alt="" className="size-full" src={src} />
        <canvas aria-hidden="true" className="absolute inset-0 size-full opacity-0" ref={canvas} />
      </div>
      <figcaption className="text-sm font-semibold">{reveal.name}</figcaption>
    </figure>
  );
}

export function TarotAnnouncement({ name }: { name: string }) {
  const { copy } = useBoardUi();
  return (
    <div aria-live="polite" className="sr-only">
      {name && fill(copy.tarotRevealed, { card: name })}
    </div>
  );
}
