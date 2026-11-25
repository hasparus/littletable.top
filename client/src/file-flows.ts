import { defaultHandleExternalFileContent, type Editor, type TLUiToastsContextType } from "tldraw";

import type { Copy } from "./copy";

import {
  type BoardFiles,
  bringImagesOver,
  keepLinksPlain,
  type UploadRefusal,
  UploadRefused,
} from "./assets";
import { fill } from "./copy";
import { fitForUpload, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from "./images";
import { exportTldr, ImportRefused, importTldr, isTldrFile, MAX_TLDR_BYTES } from "./tldr";

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
    case "damaged-image":
      return fill(copy.boardFileDamagedImage, { name: refused.image ?? "" });
    case "failed":
      return copy.boardFileImportFailed;
    case "images":
      return fill(copy.boardFileImageFailed, {
        name: refused.image ?? "",
        reason: refusalText(
          copy,
          refused.cause instanceof UploadRefused ? refused.cause.reason : "failed",
        ),
      });
    case "legacy":
      return copy.boardFileLegacy;
    case "not-tldraw":
      return copy.boardFileNotTldraw;
    case "readonly":
      return copy.boardFileReadOnly;
    case "too-large":
      return fill(copy.boardFileTooLarge, { size: megabytes(MAX_TLDR_BYTES) });
    case "too-many-pages":
      return fill(copy.boardFileTooManyPages, { max, room: refused.room });
    case "too-new":
      return copy.boardFileTooNew;
    case "unreadable":
      return copy.boardFileUnreadable;
  }
}

export type FileFlow = { copy: Copy; files: BoardFiles; toasts: TLUiToastsContextType };

const IMPORT_RESULT = "board-file-import-result";

async function importBoardFile(
  editor: Editor,
  file: File,
  { copy, files, toasts }: FileFlow,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || editor.isDisposed) return;
  const started = await files.runImport(file.name, async (report) => {
    toasts.removeToast(IMPORT_RESULT);
    try {
      await importTldr(editor, file, {
        keepFirstPage: files.keepFirstPage,
        report,
        signal,
        upload: async (image, uploadSignal, { onProgress, onThrottle }) => {
          const fitted = image.size > MAX_IMAGE_BYTES ? await fitForUpload(image) : image;
          const uploaded = await files.upload(fitted, uploadSignal, {
            onProgress: (loaded) => {
              if (fitted.size > 0) onProgress(Math.min(1, loaded / fitted.size));
            },
            onThrottle,
          });
          return uploaded.src;
        },
      });
      if (!signal.aborted) {
        toasts.addToast({ id: IMPORT_RESULT, severity: "success", title: copy.boardFileAdded });
      }
    } catch (error) {
      if (signal.aborted || editor.isDisposed) return;
      const refused = error instanceof ImportRefused ? error : new ImportRefused("failed");
      console.error("board: .tldr import failed", error);
      toasts.addToast({
        description: problemText(copy, refused, editor.options.maxPages),
        id: IMPORT_RESULT,
        keepOpen: true,
        severity: "error",
        title: fill(copy.boardFileFailedTitle, { name: file.name }),
      });
    }
  });
  if (!started && !signal.aborted) toasts.addToast({ severity: "info", title: copy.boardFileBusy });
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

function pickTldr(importFile: (file: File) => Promise<void>): void {
  const input = document.createElement("input");
  input.type = "file";
  // WARNING: On iOS, an accept filter disables .tldr files because the system does not recognize the extension.
  input.addEventListener(
    "change",
    () => {
      const [file] = input.files ?? [];
      if (file !== undefined) void importFile(file);
    },
    { once: true },
  );
  input.click();
}

/** The picker, drops and pastes share the active editor's file handling. */
export function handleFiles(
  editor: Editor,
  flow: FileFlow & { msg: (id: string) => string },
): () => void {
  const { copy, files, msg, toasts } = flow;
  // WARNING: Layer switches leave the previous editor mounted for sync. File work must stop at deactivation.
  const lifetime = new AbortController();
  const active = () => !lifetime.signal.aborted && !editor.isDisposed;
  const importFile = (file: File) => importBoardFile(editor, file, flow, lifetime.signal);
  files.chooseImportFile = () => pickTldr(importFile);
  let explained = 0;
  files.onRefused = (reason) => {
    explained++;
    toasts.addToast({ severity: "error", title: refusalText(copy, reason) });
  };
  // WARNING: Suppress tldraw’s generic upload error only when the board has already shown the specific reason.
  const quietToasts: TLUiToastsContextType = {
    ...toasts,
    addToast: (toast) => {
      if (explained > 0 && toast.title === msg("assets.files.upload-failed")) {
        explained--;
        return "";
      }
      return toasts.addToast(toast);
    },
  };
  keepLinksPlain(editor);
  const stopBringing = bringImagesOver(editor, files, () =>
    toasts.addToast({ severity: "error", title: copy.imageFromOtherBoard }),
  );
  editor.registerExternalContentHandler("files", async (content) => {
    if (!active()) return;
    for (const file of content.files.filter(isTldrFile)) {
      await importFile(file);
      if (!active()) return;
    }
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
    if (!active()) return;
    await defaultHandleExternalFileContent(
      editor,
      { ...content, files: fitted },
      { ...MEDIA_PROPS, msg, toasts: quietToasts },
    );
  });
  return () => {
    lifetime.abort();
    editor.registerExternalContentHandler("files", null);
    stopBringing();
    files.chooseImportFile = null;
    files.onRefused = null;
  };
}
