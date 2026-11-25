import {
  AssetRecordType,
  createBindingId,
  createShapeId,
  type Editor,
  getIndicesAbove,
  PageRecordType,
  serializeTldrawJson,
  sortByIndex,
  type TLAsset,
  type TLBinding,
  TLDRAW_FILE_EXTENSION,
  type TLPage,
  type TLRecord,
  type TLShape,
} from "tldraw";

import type { BoardDocument, ImportReply } from "./tldr-worker";

// tldraw's own file format, a .tldr: the whole document as JSON, with each
// image embedded as a data: URL so the file opens anywhere tldraw does.

// Embedded images grow by a third as base64; a board's whole quota of
// images (src/limits.ts) fits with room to spare.
export const MAX_TLDR_BYTES = 400 * 1024 * 1024;

const TLDR_TYPE = "application/vnd.tldraw+json";

export type ImportProblem =
  | "damaged"
  | "damaged-image"
  | "failed"
  | "images"
  | "legacy"
  | "not-tldraw"
  | "readonly"
  | "too-large"
  | "too-many-pages"
  | "too-new"
  | "unreadable";

export type ImportProgress =
  | { count: number; done: number; kind: "uploading"; percent: number; waiting: boolean }
  | { kind: "adding" }
  | { kind: "preparing" }
  | { kind: "reading"; percent: number };

export class ImportRefused extends Error {
  override name = "ImportRefused";
  readonly image: string | undefined;
  readonly room: number;

  constructor(
    readonly problem: ImportProblem,
    options?: ErrorOptions & { image?: string; room?: number },
  ) {
    super(`board: .tldr import refused (${problem})`, options);
    this.image = options?.image;
    this.room = options?.room ?? 0;
  }
}

export const isTldrFile = (file: File) =>
  file.name.toLowerCase().endsWith(TLDRAW_FILE_EXTENSION) || file.type === TLDR_TYPE;

// The board as one .tldr. tldraw fetches each image the document points at
// (through the asset store's resolve, which keeps the files cookie fresh)
// and embeds it; one it could not fetch would stay a bare address, which
// opens nowhere else, so the export fails instead.
export async function exportTldr(editor: Editor): Promise<Blob> {
  const json = await serializeTldrawJson(editor);
  const { records } = JSON.parse(json) as { records: TLRecord[] };
  const missing = records.filter(
    (record) =>
      record.typeName === "asset" &&
      record.type !== "bookmark" &&
      typeof record.props.src === "string" &&
      record.props.src !== "" &&
      !record.props.src.startsWith("data:"),
  );
  if (missing.length > 0) throw new Error(`board: ${missing.length} images were not embedded`);
  return new Blob([json], { type: TLDR_TYPE });
}

const UPLOADS_AT_ONCE = 4;
type Plan = { assets: TLAsset[]; bindings: TLBinding[]; pages: TLPage[]; shapes: TLShape[] };
type ReportProgress = (progress: ImportProgress) => void;

function readBoard(
  file: File,
  report: ReportProgress,
  signal: AbortSignal,
): Promise<BoardDocument> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("tldr-worker.ts", import.meta.url), { type: "module" });
  let onAbort: () => void;
  return new Promise<BoardDocument>((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("error", () => reject(new ImportRefused("failed")));
    worker.addEventListener("messageerror", () => reject(new ImportRefused("failed")));
    worker.addEventListener("message", ({ data }: MessageEvent<ImportReply>) => {
      if (data.kind === "loaded") resolve(data.document);
      else if (data.kind === "failed")
        reject(new ImportRefused(data.problem, { image: data.image }));
      else report(data);
    });
    worker.postMessage(file);
  }).finally(() => {
    signal.removeEventListener("abort", onAbort);
    worker.terminate();
  });
}

type Upload = (
  file: File,
  signal: AbortSignal,
  callbacks: { onProgress: (fraction: number) => void; onThrottle: (waiting: boolean) => void },
) => Promise<string>;

async function uploadEmbedded(
  embedded: BoardDocument["embedded"],
  upload: Upload,
  report: ReportProgress,
  signal: AbortSignal,
) {
  const images = [...embedded];
  const uploaded = new Map<TLAsset["id"], string>();
  if (images.length === 0) return uploaded;

  const batch = new AbortController();
  const pending = AbortSignal.any([signal, batch.signal]);
  const fractions = new Float64Array(images.length);
  const waiting = new Set<number>();
  const count = images.length;
  let transferred = 0;
  let done = 0;
  let next = 0;
  const progress = () => {
    const percent = Math.min(done === count ? 100 : 99, Math.round((transferred / count) * 100));
    const active = Math.min(UPLOADS_AT_ONCE, count - done);
    report({
      count,
      done,
      kind: "uploading",
      percent,
      waiting: active > 0 && waiting.size === active,
    });
  };
  progress();
  const lane = async () => {
    while (!pending.aborted && next < count) {
      const index = next++;
      const [id, image] = images[index]!;
      const moved = (fraction: number) => {
        transferred += fraction - fractions[index]!;
        fractions[index] = fraction;
        progress();
      };
      try {
        const src = await upload(image, pending, {
          onProgress: moved,
          onThrottle: (paused) => {
            if (paused) waiting.add(index);
            else waiting.delete(index);
            progress();
          },
        });
        uploaded.set(id, src);
        done++;
        moved(1);
      } catch (error) {
        if (!pending.aborted)
          batch.abort(new ImportRefused("images", { cause: error, image: image.name }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, count) }, lane));
  pending.throwIfAborted();
  return uploaded;
}

// Gives every record the file brings an id of its own on this board: its
// own where it is free, a new one where the board already has it, with
// parents, bindings and images following the new ids.
function planIds(editor: Editor, plan: Plan, replacing: TLPage | null): Plan {
  const taken = (id: string) => editor.store.has(id as TLRecord["id"]) && id !== replacing?.id;
  const ids = new Map<string, string>();
  const claim = (id: string, fresh: () => string) => ids.set(id, taken(id) ? fresh() : id);
  for (const page of plan.pages) claim(page.id, () => PageRecordType.createId());
  for (const shape of plan.shapes) claim(shape.id, () => createShapeId());
  for (const binding of plan.bindings) claim(binding.id, () => createBindingId());
  for (const asset of plan.assets) claim(asset.id, () => AssetRecordType.createId());
  const to = <T extends string>(id: T): T => (ids.get(id) ?? id) as T;

  const lastPage = editor.getPages().at(-1)?.index;
  const indices =
    replacing === null
      ? getIndicesAbove(lastPage, plan.pages.length)
      : plan.pages.map((page) => page.index);
  return {
    assets: plan.assets.map((asset) => ({ ...asset, id: to(asset.id) })),
    bindings: plan.bindings.map((binding) => ({
      ...binding,
      fromId: to(binding.fromId),
      id: to(binding.id),
      toId: to(binding.toId),
    })),
    pages: plan.pages.map((page, at) => ({ ...page, id: to(page.id), index: indices[at]! })),
    shapes: plan.shapes.map((shape) => {
      const moved = { ...shape, id: to(shape.id), parentId: to(shape.parentId) };
      const props = shape.props as { assetId?: string | null };
      if (typeof props.assetId === "string") {
        moved.props = { ...shape.props, assetId: to(props.assetId) } as TLShape["props"];
      }
      return moved as TLShape;
    }),
  };
}

// A board nobody has drawn on yet: one page and no shapes.
const isUntouched = (editor: Editor) =>
  editor.getPages().length === 1 &&
  !editor.store.allRecords().some((record) => record.typeName === "shape");

function replacementPage(editor: Editor, pages: TLPage[], keepFirstPage: boolean): TLPage | null {
  if (editor.getIsReadonly()) throw new ImportRefused("readonly");
  const replacing = !keepFirstPage && isUntouched(editor) ? editor.getPages()[0]! : null;
  const room = editor.options.maxPages - editor.getPages().length + (replacing === null ? 0 : 1);
  if (pages.length > room) throw new ImportRefused("too-many-pages", { room });
  return replacing;
}

// Adds pages after the board's own, or in place of an untouched board's empty
// page. Embedded images are uploaded before the document points at them.
export async function importTldr(
  editor: Editor,
  file: File,
  {
    keepFirstPage,
    report,
    signal,
    upload,
  }: { keepFirstPage: boolean; report: ReportProgress; signal: AbortSignal; upload: Upload },
): Promise<void> {
  if (file.size > MAX_TLDR_BYTES) throw new ImportRefused("too-large");
  const { assets, bindings, embedded, pages, shapes } = await readBoard(file, report, signal);
  signal.throwIfAborted();
  if (pages.length === 0) throw new ImportRefused("damaged");
  pages.sort(sortByIndex);
  replacementPage(editor, pages, keepFirstPage);
  const uploaded = await uploadEmbedded(embedded, upload, report, signal);
  signal.throwIfAborted();
  // Someone may have drawn or added pages while the images were uploading.
  const replacing = replacementPage(editor, pages, keepFirstPage);
  report({ kind: "adding" });

  const plan = planIds(
    editor,
    {
      assets: assets.map((asset) =>
        uploaded.has(asset.id)
          ? ({ ...asset, props: { ...asset.props, src: uploaded.get(asset.id)! } } as TLAsset)
          : asset,
      ),
      bindings,
      pages,
      shapes,
    },
    replacing,
  );
  editor.markHistoryStoppingPoint("import .tldr");
  editor.run(() => {
    editor.store.put([...plan.assets, ...plan.pages, ...plan.shapes, ...plan.bindings]);
    if (replacing !== null && !plan.pages.some((page) => page.id === replacing.id)) {
      editor.deletePage(replacing.id);
    }
    editor.setCurrentPage(plan.pages[0]!.id);
  });
  editor.zoomToFit({ immediate: true });
}
