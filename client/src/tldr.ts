import {
  AssetRecordType,
  createBindingId,
  createShapeId,
  type Editor,
  getIndicesAbove,
  MigrationFailureReason,
  PageRecordType,
  parseTldrawJsonFile,
  serializeTldrawJson,
  sortByIndex,
  type TLAsset,
  type TLBinding,
  TLDRAW_FILE_EXTENSION,
  type TldrawFileParseError,
  type TLImageAsset,
  type TLPage,
  type TLRecord,
  type TLShape,
  type TLVideoAsset,
} from "tldraw";

// tldraw's own file format, a .tldr: the whole document as JSON, with each
// image embedded as a data: URL so the file opens anywhere tldraw does.

// Embedded images grow by a third as base64; a board's whole quota of
// images (src/limits.ts) fits with room to spare.
export const MAX_TLDR_BYTES = 400 * 1024 * 1024;

const TLDR_TYPE = "application/vnd.tldraw+json";

export type ImportProblem =
  | "damaged"
  | "images"
  | "not-tldraw"
  | "too-large"
  | "too-many-pages"
  | "too-new";

export class ImportRefused extends Error {
  override name = "ImportRefused";
  // How many more pages the board had room for, for "too-many-pages".
  readonly room: number;

  constructor(
    readonly problem: ImportProblem,
    options?: ErrorOptions & { room?: number },
  ) {
    super(`board: .tldr import refused (${problem})`, options);
    this.room = options?.room ?? 0;
  }
}

export const isTldrFile = (file: File) =>
  file.name.toLowerCase().endsWith(TLDRAW_FILE_EXTENSION) || file.type === TLDR_TYPE;

const isEmbedded = (asset: TLAsset): asset is TLImageAsset | TLVideoAsset =>
  (asset.type === "image" || asset.type === "video") &&
  typeof asset.props.src === "string" &&
  asset.props.src.startsWith("data:");

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

// NOTE: tldraw answers a file from a newer schema with a plain migration
// error ("Incompatible schema?"), so the versions are compared here.
function isNewer(json: string, schema: Editor["store"]["schema"]): boolean {
  const ours = schema.serialize().sequences;
  const theirs = (JSON.parse(json) as { schema?: { sequences?: unknown } }).schema?.sequences;
  if (typeof theirs !== "object" || theirs === null) return false;
  return Object.entries(theirs).some(
    ([sequence, version]) => sequence in ours && Number(version) > ours[sequence]!,
  );
}

function problemOf(error: TldrawFileParseError, newer: () => boolean): ImportProblem {
  switch (error.type) {
    case "fileFormatVersionTooNew":
      return "too-new";
    case "invalidRecords":
      return "damaged";
    case "migrationFailed":
      return error.reason === MigrationFailureReason.TargetVersionTooNew || newer()
        ? "too-new"
        : "damaged";
    case "notATldrawFile":
    case "v1File":
      return "not-tldraw";
  }
}

export function fileFromDataUrl(url: string, name: string): File {
  const comma = url.indexOf(",");
  const header = url.slice(5, comma);
  const type = header.split(";")[0] || "application/octet-stream";
  const data = url.slice(comma + 1);
  const bytes = header.endsWith(";base64")
    ? Uint8Array.from(atob(data), (char) => char.codePointAt(0)!)
    : new TextEncoder().encode(decodeURIComponent(data));
  return new File([bytes], name || "image", { type });
}

// Runs at most `limit` of the tasks at a time; the first failure fails all.
async function inTurns<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const UPLOADS_AT_ONCE = 4;

type Plan = { assets: TLAsset[]; bindings: TLBinding[]; pages: TLPage[]; shapes: TLShape[] };

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

// Adds the file's pages to the board, after its own, never in place of
// them. On a board nobody has drawn on, the file's pages take the empty
// page's place, so the board then reads exactly as the file. Images the
// file embeds are uploaded first, and the document only ever points at
// them; if any upload fails, nothing is added.
export async function importTldr(
  editor: Editor,
  file: File,
  upload: (file: File) => Promise<string>,
): Promise<{ pages: number }> {
  if (file.size > MAX_TLDR_BYTES) throw new ImportRefused("too-large");
  const json = await file.text();
  const { schema } = editor.store;
  const parsed = parseTldrawJsonFile({ json, schema });
  if (!parsed.ok) throw new ImportRefused(problemOf(parsed.error, () => isNewer(json, schema)));
  const records = parsed.value.allRecords();
  const pages = records
    .filter((record): record is TLPage => record.typeName === "page")
    .sort(sortByIndex);
  if (pages.length === 0) throw new ImportRefused("damaged");
  // NOTE: tldraw's own page cap holds for pages made in its menu; a file
  // that would pass it is refused whole, before any image is uploaded,
  // rather than added in part.
  const replacing = isUntouched(editor) ? editor.getPages()[0]! : null;
  const room = editor.options.maxPages - editor.getPages().length + (replacing === null ? 0 : 1);
  if (pages.length > room) throw new ImportRefused("too-many-pages", { room });
  const assets = records.filter((record): record is TLAsset => record.typeName === "asset");

  const uploaded = new Map<string, string>();
  try {
    await inTurns(assets.filter(isEmbedded), UPLOADS_AT_ONCE, async (asset) => {
      const embedded = fileFromDataUrl(asset.props.src as string, asset.props.name);
      uploaded.set(asset.id, await upload(embedded));
    });
  } catch (error) {
    throw new ImportRefused("images", { cause: error });
  }

  const plan = planIds(
    editor,
    {
      assets: assets.map((asset) =>
        uploaded.has(asset.id)
          ? ({ ...asset, props: { ...asset.props, src: uploaded.get(asset.id)! } } as TLAsset)
          : asset,
      ),
      bindings: records.filter((record): record is TLBinding => record.typeName === "binding"),
      pages,
      shapes: records.filter((record): record is TLShape => record.typeName === "shape"),
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
  return { pages: plan.pages.length };
}
