import { defaultHandleExternalFileContent, type Editor, type TLUiToastsContextType } from "tldraw";

import type { Copy } from "./copy";

import { type BoardFiles, keepLinksPlain, type UploadRefusal } from "./assets";
import { fill } from "./copy";
import { fitForUpload, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from "./images";
import { exportTldr, ImportRefused, importTldr, isTldrFile, MAX_TLDR_BYTES } from "./tldr";

// What tldraw takes in: still and animated images and SVG (which tldraw
// sanitises before it uploads), no video. tldraw sizes an image's shape to
// MAX_IMAGE_SIDE, the same budget its bytes are redrawn to (images.ts).
export const MEDIA_PROPS = {
  acceptedImageMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/apng",
    "image/avif",
    "image/svg+xml",
  ],
  acceptedVideoMimeTypes: [],
  maxAssetSize: MAX_IMAGE_BYTES,
  maxImageDimension: MAX_IMAGE_SIDE,
} as const;

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

function refusalText(copy: Copy, reason: UploadRefusal): string {
  switch (reason) {
    case "failed":
      return copy.imageFailed;
    case "over-quota":
      return copy.imagesOverQuota;
    case "too-fast":
      return copy.imagesTooFast;
    case "too-large":
      return fill(copy.imageTooLarge, { size: megabytes(MAX_IMAGE_BYTES) });
    case "unsupported":
      return copy.imageUnsupported;
  }
}

function problemText(copy: Copy, refused: ImportRefused, max: number): string {
  switch (refused.problem) {
    case "damaged":
      return copy.boardFileDamaged;
    case "images":
      return copy.boardFileImagesFailed;
    case "not-tldraw":
      return copy.boardFileNotTldraw;
    case "too-large":
      return fill(copy.boardFileTooLarge, { size: megabytes(MAX_TLDR_BYTES) });
    case "too-many-pages":
      return fill(copy.boardFileTooManyPages, { max, room: refused.room });
    case "too-new":
      return copy.boardFileTooNew;
  }
}

export type FileFlow = { copy: Copy; files: BoardFiles; toasts: TLUiToastsContextType };

export async function openTldr(
  editor: Editor,
  file: File,
  { copy, files, toasts }: FileFlow,
): Promise<void> {
  const opening = toasts.addToast({ keepOpen: true, title: copy.boardFileOpening });
  try {
    // NOTE: an embedded image keeps its exact bytes unless the Worker
    // could not take them as they are.
    await importTldr(editor, file, async (image) => {
      const fitted = image.size > MAX_IMAGE_BYTES ? await fitForUpload(image) : image;
      const uploaded = await files.upload(fitted);
      return uploaded.src;
    });
    toasts.addToast({ severity: "success", title: copy.boardFileAdded });
  } catch (error) {
    console.error("board: could not open the file", error);
    const refused = error instanceof ImportRefused ? error : new ImportRefused("damaged");
    toasts.addToast({
      severity: "error",
      title: problemText(copy, refused, editor.options.maxPages),
    });
  } finally {
    toasts.removeToast(opening);
  }
}

const fileName = (title: string) =>
  title.replaceAll(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || "board";

export async function downloadTldr(editor: Editor, { copy, toasts }: FileFlow): Promise<void> {
  try {
    const url = URL.createObjectURL(await exportTldr(editor));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName(document.title)}.tldr`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    console.error("board: could not export the board", error);
    toasts.addToast({ severity: "error", title: copy.boardFileDownloadFailed });
  }
}

export function pickTldr(editor: Editor, flow: FileFlow): void {
  const input = document.createElement("input");
  input.type = "file";
  // NOTE: no accept filter: iOS greys out files of a type it does not
  // know, and it knows no .tldr. Anything else is refused once read.
  input.addEventListener("change", () => {
    const [file] = input.files ?? [];
    if (file !== undefined) void openTldr(editor, file, flow);
  });
  input.click();
}

// Every way a file arrives (the picker, a drop, a paste) goes through one
// handler, which opens .tldr files, redraws photos too large for the board,
// and hands the rest to tldraw's own handling. A refused upload says why,
// once. Answers the cleanup.
export function handleFiles(
  editor: Editor,
  flow: FileFlow & { msg: (id: string) => string },
): () => void {
  const { copy, files, msg, toasts } = flow;
  let explained = 0;
  files.onRefused = (reason) => {
    explained++;
    toasts.addToast({ severity: "error", title: refusalText(copy, reason) });
  };
  const uploadFailed = msg("assets.files.upload-failed");
  // NOTE: tldraw follows a failed upload with its own "Upload failed"; the
  // board has already said why.
  const quietToasts: TLUiToastsContextType = {
    ...toasts,
    addToast: (toast) => {
      if (toast.title === uploadFailed && explained > 0) {
        explained--;
        return "";
      }
      return toasts.addToast(toast);
    },
  };
  keepLinksPlain(editor);
  editor.registerExternalContentHandler("files", async (content) => {
    for (const file of content.files.filter(isTldrFile)) await openTldr(editor, file, flow);
    const images = content.files.filter((file) => !isTldrFile(file));
    if (images.length === 0) return;
    const fitted = await Promise.all(
      images.map((file) =>
        fitForUpload(file).catch((error: unknown) => {
          console.warn("board: could not redraw an image", error);
          return file;
        }),
      ),
    );
    await defaultHandleExternalFileContent(
      editor,
      { ...content, files: fitted },
      { ...MEDIA_PROPS, msg, toasts: quietToasts },
    );
  });
  return () => {
    files.onRefused = null;
  };
}
