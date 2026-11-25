import type { Editor } from "tldraw";

import { Popover } from "radix-ui";
import { useState } from "react";
import { useValue } from "tldraw";

import type { PassKeeper } from "./bootstrap";
import type { Copy } from "./copy";

import { MAX_FILE_BYTES } from "../../src/limits";
import { useBoardName } from "./board-name";
import { MENU_BUTTON } from "./front-menu";

export function BoardShare({
  copy,
  editor,
  keeper,
}: {
  copy: Copy;
  editor: Editor | null;
  keeper: PassKeeper;
}) {
  const { publication, board } = keeper.bootstrap;
  const title = useBoardName()?.title ?? keeper.bootstrap.title;
  const endpoint = `/api/boards/${encodeURIComponent(board)}/publish`;
  const [published, setPublished] = useState(publication?.url ?? null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const pageContent = useValue(
    "shared page contents",
    () => editor?.getSortedChildIdsForParent(editor.getCurrentPageId()),
    [editor],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await action();
    } catch {
      setStatus(copy.shareFailed);
    }
    setBusy(false);
  }

  async function copyLink(path: string) {
    await navigator.clipboard.writeText(new URL(path, location.origin).href);
    setStatus(copy.linkCopied);
  }

  async function renderPage(scale = 1) {
    if (!editor || !pageContent?.length) throw new Error("Page unavailable");
    return editor.toImage(pageContent, {
      background: true,
      format: "png",
      pixelRatio: 1,
      scale,
    });
  }

  async function download() {
    const { blob } = await renderPage();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function publish() {
    if (!publication) return;
    const image = await renderPage();
    let body = image.blob;
    if (body.size > MAX_FILE_BYTES) {
      // WARNING: Reserve room for PNG scanlines and headers beyond the four bytes per pixel.
      const scale = Math.sqrt(MAX_FILE_BYTES / (5 * image.width * image.height));
      const smaller = await renderPage(Math.min(scale, 0.9));
      body = smaller.blob;
    }
    const response = await fetch(endpoint, {
      body,
      headers: { "Content-Type": "image/png", "X-CSRF-Token": publication.csrf },
      method: "POST",
    });
    if (!response.ok) throw new Error("Publish failed");
    const result: { url: string } = await response.json();
    setPublished(result.url);
    setStatus(copy.publishedPage);
  }

  async function unpublish() {
    if (!publication) return;
    const response = await fetch(endpoint, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": publication.csrf },
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Unpublish failed");
    setPublished(null);
    setStatus(copy.unpublishedPage);
  }

  function action(label: string, handler: () => Promise<void>, disabled = false) {
    return (
      <button
        className={MENU_BUTTON}
        disabled={busy || disabled}
        onClick={() => void run(handler)}
        type="button"
      >
        {label}
      </button>
    );
  }

  return (
    <Popover.Root onOpenChange={() => setStatus("")}>
      <Popover.Trigger className="px-3.5">{copy.share}</Popover.Trigger>
      <Popover.Content
        align="end"
        aria-label={copy.share}
        className="w-max max-w-64 rounded-xl border border-border bg-bg-secondary p-1 text-foreground shadow-toast [&_button:disabled]:opacity-50"
        collisionPadding={8}
        sideOffset={4}
      >
        {action(copy.copyEditLink, () => copyLink(location.pathname))}
        {action(copy.exportPage, download, !pageContent?.length)}
        {publication &&
          action(
            published ? copy.updatePublication : copy.publishPage,
            publish,
            !pageContent?.length,
          )}
        {published && (
          <>
            {action(copy.copyPublishedLink, () => copyLink(published))}
            {action(copy.unpublishPage, unpublish)}
          </>
        )}
        <p className="px-3 py-2 text-sm empty:hidden" role="status">
          {status}
        </p>
      </Popover.Content>
    </Popover.Root>
  );
}
