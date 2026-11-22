import { useEffect } from "react";
import {
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  useEditor,
  useToasts,
  useTranslation,
  useValue,
} from "tldraw";

import { fill } from "./copy";
import { downloadTldr, handleFiles, pickTldr } from "./file-flows";
import { useBoardUi } from "./ui";

// Wires the board's images and .tldr files into tldraw, and shows how the
// uploads under way are going.
export function BoardFileHandlers() {
  const { copy, files } = useBoardUi();
  const editor = useEditor();
  const toasts = useToasts();
  const msg = useTranslation();
  useEffect(
    () => handleFiles(editor, { copy, files, msg, toasts }),
    [copy, editor, files, msg, toasts],
  );

  const progress = useValue("board uploads", () => files.progress.get(), [files]);
  if (progress.count === 0) return null;
  const percent = progress.total === 0 ? 0 : Math.round((progress.loaded / progress.total) * 100);
  return (
    <p
      className="pointer-events-none fixed inset-x-0 top-[calc(max(0.75rem,env(safe-area-inset-top))+3rem)] z-30 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full bg-ink px-4 py-2 text-center text-sm text-white tabular-nums shadow-lg"
      role="status"
    >
      {fill(copy.imagesUploading, { count: progress.count, done: progress.done + 1, percent })}
    </p>
  );
}

// The main menu's way to take the whole board away as a .tldr file and to
// bring one in.
export function BoardFileMenuItems() {
  const editor = useEditor();
  const toasts = useToasts();
  const { copy, files } = useBoardUi();
  const flow = { copy, files, toasts };
  return (
    <TldrawUiMenuGroup id="board-file">
      <TldrawUiMenuItem
        id="board-file-download"
        label={copy.boardFileDownload}
        onSelect={() => void downloadTldr(editor, flow)}
      />
      <TldrawUiMenuItem
        id="board-file-open"
        label={copy.boardFileOpen}
        onSelect={() => pickTldr(editor, flow)}
      />
    </TldrawUiMenuGroup>
  );
}
