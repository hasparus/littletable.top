import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import {
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  useEditor,
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
  const msg = useTranslation();
  const translate = useEffectEvent((id: string) => msg(id));
  useEffect(
    () => handleFiles(editor, { copy, files, msg: (id) => translate(id), toasts }),
    [copy, editor, files, toasts],
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

const PHONE_IMPORT = "(width < 640px)";

function subscribePhoneImport(change: () => void) {
  const media = matchMedia(PHONE_IMPORT);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
}

const isPhoneImport = () => matchMedia(PHONE_IMPORT).matches;

function ImportStatus({
  copy,
  name,
  progress,
}: {
  copy: Copy;
  name: string;
  progress: ImportProgress;
}) {
  const fullScreen = useSyncExternalStore(subscribePhoneImport, isPhoneImport);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = fill(copy.boardFileImporting, { name });
  useEffect(() => {
    dialog.current?.showModal();
  }, [fullScreen]);
  const label = importStage(copy, progress);
  const percent = "percent" in progress ? progress.percent : undefined;
  const status = (
    <>
      <p className="text-xl font-semibold wrap-anywhere sm:truncate sm:text-sm">{title}</p>
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
        className="mt-4 block h-2 w-full accent-primary sm:mt-2 sm:h-1"
        max={100}
        value={percent}
      />
      {progress.kind === "uploading" && progress.waiting && (
        <p className="mt-2 text-foreground-secondary" role="status">
          {copy.boardFileWaiting}
        </p>
      )}
    </>
  );
  return fullScreen ? (
    <dialog
      aria-label={title}
      className="pointer-events-auto fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-auto bg-background text-foreground"
      onCancel={(event) => event.preventDefault()}
      ref={dialog}
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-6 py-[max(1.5rem,env(safe-area-inset-top),env(safe-area-inset-bottom))]">
        {status}
      </div>
    </dialog>
  ) : (
    <div className="w-full rounded-xl border border-border bg-bg-secondary px-3 py-2 shadow-board-control">
      {status}
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
