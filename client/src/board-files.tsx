import { useEffect } from "react";
import {
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  useEditor,
  useEvent,
  useToasts,
  useTranslation,
  useValue,
} from "tldraw";

import type { Copy } from "./copy";
import type { ImportProgress } from "./tldr";

import { fill } from "./copy";
import { downloadTldr, handleFiles } from "./file-flows";
import { useBoardUi } from "./ui";

// Wires the board's images and .tldr files into tldraw while the editor is active.
export function BoardFileHandlers() {
  const { copy, files } = useBoardUi();
  const editor = useEditor();
  const toasts = useToasts();
  const msg = useEvent(useTranslation());
  useEffect(
    () => handleFiles(editor, { copy, files, msg, toasts }),
    [copy, editor, files, msg, toasts],
  );
  return null;
}

function importStage(copy: Copy, progress: ImportProgress): string {
  switch (progress.kind) {
    case "adding":
      return copy.boardFileAdding;
    case "preparing":
      return copy.boardFilePreparing;
    case "reading":
      return copy.boardFileReading;
    case "uploading":
      return fill(copy.boardFileUploading, { count: progress.count, done: progress.done });
  }
}

export function BoardStatus({ offline }: { offline: boolean }) {
  const { copy, files } = useBoardUi();
  const uploads = useValue("board uploads", () => files.progress.get(), [files]);
  const importing = useValue("board import", () => files.importProgress.get(), [files]);
  if (importing === null && uploads.count === 0 && !offline) return null;
  const percent = uploads.total === 0 ? 0 : Math.round((uploads.loaded / uploads.total) * 100);
  const pill = "w-fit rounded-full bg-ink px-4 py-2 text-center text-white shadow-toast";
  return (
    <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--board-top)+var(--board-top-control-size)+0.5rem)] z-30 mx-auto flex max-w-sm flex-col items-center gap-2 text-sm [body:has([data-dice-toast=below])_&]:top-[calc(env(safe-area-inset-top)+6.25rem)]">
      {offline && (
        <p className={pill} role="status">
          {copy.connectionLost}
        </p>
      )}
      {importing === null && uploads.count > 0 && (
        <p className={pill} role="status">
          {fill(copy.imagesUploading, { count: uploads.count, done: uploads.done + 1, percent })}
        </p>
      )}
      {importing !== null && (
        <ImportStatus copy={copy} name={importing.name} progress={importing.progress} />
      )}
    </div>
  );
}

function ImportStatus({
  copy,
  name,
  progress,
}: {
  copy: Copy;
  name: string;
  progress: ImportProgress;
}) {
  const label = importStage(copy, progress);
  const percent = "percent" in progress ? progress.percent : undefined;
  return (
    <div className="w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 shadow-board-control">
      <p className="truncate font-semibold">{fill(copy.boardFileImporting, { name })}</p>
      <div
        className="mt-1 flex items-baseline justify-between gap-2 text-foreground-secondary"
        role="status"
      >
        <span>{label}</span>
        {percent !== undefined && (
          <span aria-hidden="true" className="tabular-nums">
            {percent}%
          </span>
        )}
      </div>
      <progress
        aria-label={label}
        className="mt-2 block h-1 w-full accent-primary"
        max={100}
        value={percent}
      />
      {progress.kind === "uploading" && progress.waiting && (
        <p className="mt-2 text-foreground-secondary" role="status">
          {copy.boardFileWaiting}
        </p>
      )}
    </div>
  );
}

// The main menu's way to take the whole board away as a .tldr file and to
// bring one in.
export function BoardFileMenuItems() {
  const editor = useEditor();
  const toasts = useToasts();
  const { copy, files } = useBoardUi();
  const importing = useValue("import running", () => files.importProgress.get() !== null, [files]);
  const flow = { copy, files, toasts };
  return (
    <TldrawUiMenuGroup id="board-file">
      <TldrawUiMenuItem
        id="board-file-download"
        label={copy.boardFileDownload}
        onSelect={() => void downloadTldr(editor, flow)}
      />
      <TldrawUiMenuItem
        disabled={importing}
        id="board-file-import"
        label={copy.boardFileImport}
        onSelect={() => files.chooseImportFile?.()}
      />
    </TldrawUiMenuGroup>
  );
}
