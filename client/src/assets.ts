import {
  AssetRecordType,
  atom,
  defaultHandleExternalTldrawContent,
  type Editor,
  getHashForString,
  type TLAsset,
  type TLAssetId,
  type TLAssetStore,
  type TLShapeId,
} from "tldraw";

import type { PassKeeper } from "./bootstrap";
import type { ImportProgress } from "./tldr";

import { fileFromDataUrl } from "./data-url-file";

export type UploadRefusal = "failed" | "over-quota" | "too-fast" | "too-large" | "unsupported";

export class UploadRefused extends Error {
  override name = "UploadRefused";

  constructor(readonly reason: UploadRefusal) {
    super(`board: upload refused (${reason})`);
  }
}

const REFUSAL_OF: Partial<Record<number, UploadRefusal>> = {
  400: "unsupported",
  413: "too-large",
  415: "unsupported",
  507: "over-quota",
};

const RETRY_MS = [1000, 3000, 8000];
const TOO_FAST_RETRY_MS = 15_000;
const TOO_FAST_TRIES = 5;

export type Uploaded = { bytes: number; hash: string; src: string; type: string };

export type UploadProgress = { count: number; done: number; loaded: number; total: number };

const IDLE: UploadProgress = { count: 0, done: 0, loaded: 0, total: 0 };

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

type Sent = "network" | { body: unknown; status: number };

// WARNING: Fetch does not expose upload progress. XMLHttpRequest is needed for byte counts.
function send(
  url: string,
  {
    file,
    onProgress,
    pass,
    signal,
  }: {
    file: File;
    onProgress: (loaded: number) => void;
    pass: string;
    signal?: AbortSignal;
  },
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("Authorization", `Bearer ${pass}`);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
    request.addEventListener("load", () =>
      resolve({ body: request.response as unknown, status: request.status }),
    );
    request.addEventListener("error", () => resolve("network"));
    request.addEventListener("timeout", () => resolve("network"));
    request.addEventListener("abort", () => reject(signal?.reason ?? new Error("aborted")));
    const onAbort = () => request.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    request.addEventListener("loadend", () => signal?.removeEventListener("abort", onAbort));
    request.send(file);
  });
}

export class BoardFiles {
  /**
   * Every upload since the last time none was running, for the progress
   * the board shows.
   */
  readonly progress = atom<UploadProgress>("board uploads", IDLE);
  readonly importProgress = atom<{ name: string; progress: ImportProgress } | null>(
    "board import",
    null,
  );
  chooseImportFile: (() => void) | null = null;
  readonly avatar = atom<string | null>("own avatar", null);
  readonly readable = atom("files readable", false);
  onRefused: ((reason: UploadRefusal) => void) | null = null;
  /** Schedules OCR for an image uploaded by this client. */
  onUploaded: ((hash: string) => void) | null = null;
  /** Receives the room’s OCR notifications. */
  onTextNotice: ((message: unknown) => void) | null = null;
  private cookiePass: string | null = null;
  private pendingAccess: Promise<void> | null = null;
  private readonly loaded = new Map<number, number>();
  private nextUpload = 0;

  constructor(
    private readonly keeper: PassKeeper,
    readonly keepFirstPage: boolean,
  ) {}

  async runImport(
    name: string,
    task: (report: (progress: ImportProgress) => void) => Promise<void>,
  ): Promise<boolean> {
    if (this.importProgress.get() !== null) return false;
    const report = (progress: ImportProgress) => this.importProgress.set({ name, progress });
    report({ kind: "reading", percent: 0 });
    try {
      await task(report);
    } finally {
      this.importProgress.set(null);
    }
    return true;
  }

  get path(): string {
    return `${this.keeper.room}/files`;
  }

  // WARNING: Media elements rely on the files cookie, so refresh it whenever the pass changes.
  private async access(): Promise<void> {
    const pass = await this.keeper.pass();
    if (pass === this.cookiePass) return;
    this.pendingAccess ??= fetch(`${this.path}/access`, {
      headers: { Authorization: `Bearer ${pass}` },
      method: "POST",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`board: files access ${response.status}`);
        const { avatar } = (await response.json()) as { avatar: string | null };
        this.cookiePass = pass;
        this.avatar.set(avatar);
        this.readable.set(true);
      })
      .finally(() => {
        this.pendingAccess = null;
      });
    await this.pendingAccess;
  }

  /**
   * For whoever is about to show a picture: the cookie may have run out
   * while nobody looked at one. A failure leaves initials in their place.
   */
  keepReadable(): void {
    this.access().catch((error: unknown) => {
      console.warn("board: could not open the board's files", error);
    });
  }

  private sum(): number {
    let total = 0;
    for (const loaded of this.loaded.values()) total += loaded;
    return total;
  }

  private started(id: number, size: number) {
    const current = this.progress.get();
    this.loaded.set(id, 0);
    this.progress.set({ ...current, count: current.count + 1, total: current.total + size });
  }

  private moved(id: number, loaded: number) {
    this.loaded.set(id, loaded);
    this.progress.set({ ...this.progress.get(), loaded: this.sum() });
  }

  private finished(id: number, size: number) {
    const current = this.progress.get();
    const done = current.done + 1;
    if (done === current.count) {
      this.loaded.clear();
      this.progress.set(IDLE);
      return;
    }
    this.loaded.set(id, size);
    this.progress.set({ ...current, done, loaded: this.sum() });
  }

  async upload(
    file: File,
    signal?: AbortSignal,
    callbacks?: { onProgress: (loaded: number) => void; onThrottle: (waiting: boolean) => void },
  ): Promise<Uploaded> {
    signal?.throwIfAborted();
    const id = this.nextUpload++;
    this.started(id, file.size);
    const moved = (loaded: number) => {
      this.moved(id, loaded);
      callbacks?.onProgress(loaded);
    };
    try {
      let flaky = 0;
      let tooFast = 0;
      for (;;) {
        const sent = await send(this.path, {
          file,
          onProgress: moved,
          pass: await this.keeper.pass(),
          signal,
        });
        if (sent !== "network" && sent.status >= 200 && sent.status < 300) {
          const uploaded = sent.body as Uploaded;
          this.onUploaded?.(uploaded.hash);
          return uploaded;
        }
        const status = sent === "network" ? 0 : sent.status;
        const refusal = REFUSAL_OF[status];
        if (refusal !== undefined) throw new UploadRefused(refusal);
        if (status === 429 && tooFast < TOO_FAST_TRIES) {
          tooFast++;
          callbacks?.onThrottle(true);
          await wait(TOO_FAST_RETRY_MS, signal);
          callbacks?.onThrottle(false);
        } else if ((status === 0 || status >= 500) && flaky < RETRY_MS.length) {
          await wait(RETRY_MS[flaky++]!, signal);
        } else {
          throw new UploadRefused(status === 429 ? "too-fast" : "failed");
        }
        moved(0);
      }
    } finally {
      this.finished(id, file.size);
    }
  }

  readonly store: TLAssetStore = {
    resolve: async (asset) => {
      const { src } = asset.props;
      if (typeof src !== "string" || !src.startsWith(`${this.path}/`)) return src ?? null;
      try {
        await this.access();
      } catch (error) {
        // WARNING: Preserve the image URL on access failure so the browser can use its cache. Board closure comes from pass renewal.
        console.warn("board: could not refresh image access", error);
      }
      return src;
    },
    upload: async (_asset, file, signal) => {
      try {
        const uploaded = await this.upload(file, signal);
        return { src: uploaded.src };
      } catch (error) {
        this.onRefused?.(error instanceof UploadRefused ? error.reason : "failed");
        throw error;
      }
    },
  };
}

// WARNING: tldraw's link preview fetches pasted URLs, which the board's Content-Security-Policy blocks for other origins.
export function keepLinksPlain(editor: Editor): void {
  editor.registerExternalAssetHandler("url", async ({ url }) => ({
    id: AssetRecordType.createId(getHashForString(url)),
    meta: {},
    props: { description: "", favicon: "", image: "", src: url, title: url },
    type: "bookmark",
    typeName: "asset",
  }));
}

/**
 * An image's address that is a board's files on this origin, but not this
 * board's: a paste from another board's tab, or a .tldr that points at one.
 * Its bytes are readable only while this browser holds that board's files
 * cookie, so the document must not keep the address.
 */
export function isOtherBoardsFile(src: unknown, ownPath: string): src is string {
  if (typeof src !== "string" || src.startsWith("data:") || src.startsWith("blob:")) return false;
  let url: URL;
  try {
    url = new URL(src, location.origin);
  } catch {
    return false;
  }
  return (
    url.origin === location.origin &&
    /^\/rooms\/[^/]+(?:\/secret)?\/files\//u.test(url.pathname) &&
    !url.pathname.startsWith(`${ownPath}/`)
  );
}

type Media = Extract<TLAsset, { type: "image" | "video" }>;

type Read = () => Promise<File>;

const fetched =
  (src: string, name: string): Read =>
  async () => {
    const response = await fetch(src, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`board: another board's image answered ${response.status}`);
    const blob = await response.blob();
    return new File([blob], name || "image", { type: blob.type });
  };

/**
 * Pasted images and images that point at another board's files land on
 * this board as its own uploads (docs/internals.md, "Images"):
 * - tldraw's copy embeds each image as a data: URL, and its paste reads
 *   one back with fetch, which the page's policy refuses; the board reads
 *   it itself instead;
 * - an address on another board (an image tldraw could not embed, or a
 *   .tldr pointing at one) opens only with that board's files cookie, so
 *   it is read now, while it can be, and uploaded here.
 * What cannot be read or uploaded is taken off the board with its shapes,
 * and `onDropped` says so (an upload refusal has said why already),
 * rather than leaving a picture that never loads.
 */
export function bringImagesOver(
  editor: Editor,
  files: BoardFiles,
  onDropped: () => void,
): () => void {
  const drop = (id: TLAssetId) => {
    const using: TLShapeId[] = [];
    for (const page of editor.getPages()) {
      for (const shapeId of editor.getPageShapeIds(page)) {
        const props = editor.getShape(shapeId)?.props as { assetId?: unknown } | undefined;
        if (props?.assetId === id) using.push(shapeId);
      }
    }
    editor.run(
      () => {
        editor.deleteShapes(using);
        editor.deleteAssets([id]);
      },
      // WARNING: A failed imported asset can still have locked shapes. Remove those too.
      { history: "ignore", ignoreShapeLock: true },
    );
  };
  const settle = async (id: TLAssetId, read: Read) => {
    try {
      const file = await read();
      const made = await editor.getAssetForExternalContent({ assetId: id, file, type: "file" });
      if (made === undefined) throw new Error("board: the image made no asset");
      if (editor.getAsset(id) === undefined) return;
      editor.run(() => editor.updateAssets([{ ...made, id } as Media]), { history: "ignore" });
    } catch (error) {
      console.warn("board: an image brought from elsewhere was left out", error);
      drop(id);
      if (!(error instanceof UploadRefused)) onDropped();
    }
  };

  editor.registerExternalContentHandler("tldraw", async ({ content, point }) => {
    const pending: [TLAssetId, Read][] = [];
    const assets = content.assets.map((asset) => {
      if (editor.getAsset(asset.id) !== undefined) return asset;
      if (asset.type !== "image" && asset.type !== "video") return asset;
      const { name, src } = asset.props;
      if (typeof src === "string" && src.startsWith("data:")) {
        pending.push([asset.id, async () => fileFromDataUrl(src, name)]);
      } else if (isOtherBoardsFile(src, files.path)) {
        pending.push([asset.id, fetched(src, name)]);
      } else return asset;
      return { ...asset, props: { ...asset.props, src: null } } as Media;
    });
    await defaultHandleExternalTldrawContent(editor, { content: { ...content, assets }, point });
    await Promise.all(pending.map(async ([id, read]) => settle(id, read)));
  });
  return editor.sideEffects.registerAfterCreateHandler("asset", (asset, source) => {
    if (source !== "user" || (asset.type !== "image" && asset.type !== "video")) return;
    if (!isOtherBoardsFile(asset.props.src, files.path)) return;
    void settle(asset.id, fetched(asset.props.src, asset.props.name));
  });
}
