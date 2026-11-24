import { atom, type Editor, type TLAssetId } from "tldraw";

import type { BoardFiles } from "./assets";
import type { PassKeeper } from "./bootstrap";
import type { BoardSearch } from "./search-board";
import type { EngineOutcome } from "./text-reader";

import {
  type EngineKey,
  type EngineName,
  TEXT_ENGINES,
  TEXT_FORMAT,
  type TextResult,
  type TextSource,
} from "../../src/text-result";
import { imageHash } from "./search-board";
import { TextReader } from "./text-reader";
import { PARAMS, savingData } from "./text-support";

// Text in the board's images, in this browser (docs/internals.md, "Text in images").
// It loads what has been read off the board's images already, follows the
// room's notices as more is read, and, when this person is not busy and
// the tab is in view, takes one image nobody has read yet with the
// engines this device can run, under a lease the board's Durable Object
// keeps so that two browsers do not read the same image. The uploader's
// browser takes its own images first, right away.

const KEY_OF: Record<EngineName, EngineKey> = {
  ppocr: "ppocr-v6tiny.1",
  tesseract: "tesseract-6.0.1",
};

// How long the board must have been left alone before a browser that did
// not upload an image starts reading it, and how often a lease is renewed
// (the room keeps one 30 s past its last renewal).
const IDLE_MS = 4000;
const RENEW_MS = 10_000;
// A browser asks for an image when the room's notices or a new image say
// there may be one. Only a lease that ran out goes unannounced: while
// someone else reads, it asks again once their lease could have lapsed.
// The slow fallback covers notices missed on a dropped socket.
const TAKEOVER_MS = 32_000;
const FALLBACK_MS = 5 * 60_000;
const SETTLE_MS = 500;
// After a failed reading, the next waits this long, doubling to the most.
const BACKOFF_MS = { first: 30_000, most: 10 * 60_000 };

type Pair = string;
const pair = (hash: string, engine: EngineKey): Pair => `${hash} ${engine}`;

type Listing = { failed: Set<Pair>; reading: Set<Pair>; stored: Set<Pair> };
type Reading = { engine: EngineKey; hash: string };
type Notice = { readings: Reading[]; state: "idle" | "reading" | "stored"; type: "image-text" };
type Claim = { engines: EngineKey[]; hash: string; lease: string };

const isNotice = (message: unknown): message is Notice =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "image-text" &&
  Array.isArray((message as { readings?: unknown }).readings);

const INPUT = ["pointerdown", "keydown", "wheel"] as const;

export class ImageText {
  // How many of the board's images are being read, or will be: the
  // search sheet says so while there are any.
  readonly pending = atom("images being read", 0);
  readonly #editor: Editor;
  readonly #files: BoardFiles;
  readonly #keeper: PassKeeper;
  readonly #search: BoardSearch;
  readonly #engines: EngineKey[];
  readonly #reader = new TextReader();
  readonly #listing: Listing = { failed: new Set(), reading: new Set(), stored: new Set() };
  readonly #results = new Map<string, Map<EngineKey, TextResult>>();
  readonly #fetching = new Set<Pair>();
  // Images this person uploaded, read first and whatever the connection.
  readonly #own = new Set<string>();
  #images = new Set<string>();
  #reading: string | null = null;
  #lastInput = 0;
  #failures = 0;
  #notBefore = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #settle: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  readonly #stops: (() => void)[] = [];

  constructor({
    editor,
    engines,
    files,
    keeper,
    search,
  }: {
    editor: Editor;
    engines: EngineName[];
    files: BoardFiles;
    keeper: PassKeeper;
    search: BoardSearch;
  }) {
    this.#editor = editor;
    this.#files = files;
    this.#keeper = keeper;
    this.#search = search;
    this.#engines = engines.map((engine) => KEY_OF[engine]);
  }

  start(): void {
    this.#stops.push(this.#editor.store.listen(() => this.#changed(), { scope: "document" }));
    const input = () => {
      this.#lastInput = performance.now();
    };
    for (const type of INPUT)
      document.addEventListener(type, input, { capture: true, passive: true });
    const shown = () => this.#schedule(0);
    document.addEventListener("visibilitychange", shown);
    this.#stops.push(() => {
      for (const type of INPUT) document.removeEventListener(type, input, { capture: true });
      document.removeEventListener("visibilitychange", shown);
    });
    this.#files.onUploaded = (hash) => {
      this.#own.add(hash);
      this.#schedule(0);
    };
    this.#files.onTextNotice = (message) => this.receive(message);
    this.#images = this.#boardImages();
    void this.#refresh();
  }

  dispose(): void {
    this.#disposed = true;
    for (const stop of this.#stops) stop();
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#settle !== null) clearTimeout(this.#settle);
    this.#files.onUploaded = null;
    this.#files.onTextNotice = null;
    this.#reader.stop();
  }

  // The board's images that can carry text, by the SHA-256 of their bytes:
  // those an image shape on any page shows now.
  #boardImages(): Set<string> {
    const hashes = new Set<string>();
    for (const record of this.#editor.store.allRecords()) {
      if (record.typeName !== "shape" || record.type !== "image") continue;
      const asset = (record.props as { assetId?: TLAssetId | null }).assetId;
      if (asset === null || asset === undefined) continue;
      const found = this.#editor.getAsset(asset);
      if (found?.type !== "image" || found.props.mimeType === "image/svg+xml") continue;
      const hash = imageHash(this.#editor, asset);
      if (hash !== null) hashes.add(hash);
    }
    return hashes;
  }

  #changed(): void {
    if (this.#settle !== null) return;
    this.#settle = setTimeout(() => {
      this.#settle = null;
      const before = this.#images;
      this.#images = this.#boardImages();
      for (const hash of this.#images) this.#fetchStored(hash);
      this.#count();
      if ([...this.#images].some((hash) => !before.has(hash))) this.#schedule(0);
    }, SETTLE_MS);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.#files.path}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.#keeper.pass()}`, ...init.headers },
    });
  }

  // What the room has read and is reading, for when a notice was missed
  // (a socket that dropped, a lease that ran out).
  async #refresh(thenRead = true): Promise<void> {
    try {
      const response = await this.#request("/text");
      if (!response.ok) throw new Error(`status ${response.status}`);
      const listing = (await response.json()) as Record<keyof Listing, Reading[]>;
      for (const key of ["failed", "reading", "stored"] as const) {
        this.#listing[key] = new Set(listing[key].map(({ engine, hash }) => pair(hash, engine)));
      }
    } catch (error) {
      console.warn("board: could not list the images' text", error);
    }
    for (const hash of this.#images) this.#fetchStored(hash);
    this.#count();
    if (thenRead) this.#schedule(0);
  }

  // Fetches each stored reading of the image this browser does not have.
  #fetchStored(hash: string): void {
    for (const key of Object.keys(TEXT_ENGINES) as EngineKey[]) {
      const id = pair(hash, key);
      if (!this.#listing.stored.has(id) || this.#fetching.has(id)) continue;
      if (this.#results.get(hash)?.has(key) === true) continue;
      this.#fetching.add(id);
      void this.#request(`/${hash}/text/${key}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`status ${response.status}`);
          this.#keep(hash, key, (await response.json()) as TextResult);
        })
        .catch((error: unknown) => console.warn("board: could not load an image's text", error))
        .finally(() => this.#fetching.delete(id));
    }
  }

  #keep(hash: string, key: EngineKey, result: TextResult): void {
    const readings = this.#results.get(hash) ?? new Map<EngineKey, TextResult>();
    readings.set(key, result);
    this.#results.set(hash, readings);
    this.#listing.stored.add(pair(hash, key));
    this.#listing.reading.delete(pair(hash, key));
    this.#search.setImageReadings(hash, [...readings.values()]);
    this.#count();
  }

  // A notice from the room (docs/internals.md, "Text in images"): a reading under
  // way, given up or stored.
  receive(message: unknown): void {
    if (!isNotice(message)) return;
    for (const { engine, hash } of message.readings) {
      const id = pair(hash, engine);
      if (message.state === "reading") this.#listing.reading.add(id);
      else this.#listing.reading.delete(id);
      if (message.state === "stored") this.#listing.stored.add(id);
    }
    for (const { hash } of message.readings) if (this.#images.has(hash)) this.#fetchStored(hash);
    this.#count();
    if (message.state === "idle") this.#schedule(0);
    else if (message.state === "reading" && this.#reading === null) this.#wait();
  }

  #has(hash: string, key: EngineKey, list: keyof Listing): boolean {
    return this.#listing[list].has(pair(hash, key));
  }

  // The engines of this device that have not read the image yet and have
  // not given up on it (someone may be reading it now).
  #missing(hash: string): EngineKey[] {
    return this.#engines.filter(
      (key) => !this.#has(hash, key, "stored") && !this.#has(hash, key, "failed"),
    );
  }

  #count(): void {
    const keys = Object.keys(TEXT_ENGINES) as EngineKey[];
    let pending = 0;
    for (const hash of this.#images) {
      const reading = hash === this.#reading || keys.some((key) => this.#has(hash, key, "reading"));
      const unread = !keys.some((key) => this.#has(hash, key, "stored"));
      if (reading || (unread && this.#missing(hash).length > 0)) pending++;
    }
    this.pending.set(pending);
  }

  // Images this device could still read.
  #candidates(): string[] {
    return [...new Set([...this.#images, ...this.#own])].filter(
      (hash) => this.#missing(hash).length > 0,
    );
  }

  // Nothing to claim now: waits for a notice, or for someone else's lease
  // to lapse when they may have left.
  #wait(): void {
    const othersReading = this.#candidates().some((hash) =>
      this.#missing(hash).some((key) => this.#has(hash, key, "reading")),
    );
    this.#schedule(othersReading ? TAKEOVER_MS : FALLBACK_MS);
  }

  #schedule(ms: number): void {
    if (this.#disposed) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, ms);
  }

  async #tick(): Promise<void> {
    if (this.#disposed || this.#reading !== null || this.#engines.length === 0) return;
    if (document.visibilityState === "hidden") return;
    // NOTE: an image someone else reads counts too: only the room knows
    // when their lease ran out, which no notice says.
    const candidates = this.#candidates();
    if (candidates.length === 0) return;
    const prefer = candidates.find((hash) => this.#own.has(hash)) ?? null;
    if (prefer === null) {
      const now = performance.now();
      const wait = Math.max(this.#lastInput + IDLE_MS, this.#notBefore) - now;
      if (wait > 0) return this.#schedule(wait);
      // NOTE: someone else's image waits for a browser not saving data.
      if (savingData()) return;
    }
    let claim: Claim | null = null;
    try {
      const response = await this.#request("/text/claim", {
        body: JSON.stringify({ candidates, engines: this.#engines, prefer }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (response.status === 200) claim = (await response.json()) as Claim;
      else if (response.status !== 204) throw new Error(`status ${response.status}`);
    } catch (error) {
      console.warn("board: could not claim an image to read", error);
      this.#backOff();
      return this.#schedule(this.#notBefore - performance.now());
    }
    if (claim === null) {
      await this.#refresh(false);
      return this.#wait();
    }
    await this.#read(claim);
    this.#schedule(0);
  }

  #backOff(): void {
    this.#failures++;
    const wait = Math.min(BACKOFF_MS.most, BACKOFF_MS.first * 2 ** (this.#failures - 1));
    this.#notBefore = performance.now() + wait;
  }

  async #read(claim: Claim): Promise<void> {
    const { hash, lease } = claim;
    this.#reading = hash;
    this.#count();
    const renew = setInterval(() => {
      void this.#request("/text/renew", {
        body: JSON.stringify({ lease }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);
    }, RENEW_MS);
    const failed: EngineKey[] = [];
    const source: TextSource = this.#own.has(hash) ? "uploader" : "peer";
    const started = performance.now();
    try {
      const image = await this.#request(`/${hash}`);
      if (!image.ok) throw new Error(`image ${image.status}`);
      const bytes = await image.arrayBuffer();
      const names = claim.engines.map((key) => TEXT_ENGINES[key].name);
      const uploads: Promise<unknown>[] = [];
      await this.#reader.read(bytes, names, (outcome) => {
        uploads.push(
          this.#store(hash, outcome, source).catch((error: unknown) => {
            console.warn("board: an image's text did not store", error);
            failed.push(KEY_OF[outcome.engine]);
          }),
        );
      });
      await Promise.all(uploads);
    } catch (error) {
      console.warn("board: could not read an image", error);
      for (const key of claim.engines) if (!failed.includes(key)) failed.push(key);
    } finally {
      clearInterval(renew);
      performance.measure("image-text:read", { detail: { hash }, start: started });
      this.#own.delete(hash);
      this.#reading = null;
    }
    if (failed.length > 0) this.#backOff();
    else this.#failures = 0;
    await this.#request("/text/release", {
      body: JSON.stringify({ failed, lease }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => null);
    this.#count();
  }

  async #store(hash: string, outcome: EngineOutcome, source: TextSource): Promise<void> {
    if ("failed" in outcome) throw new Error(`${outcome.engine}: ${outcome.failed}`);
    const key = KEY_OF[outcome.engine];
    const { model, name, version } = TEXT_ENGINES[key];
    const body = {
      engine: { model, name, params: PARAMS[name], version },
      format: TEXT_FORMAT,
      image: { height: outcome.size.height, sha256: hash, width: outcome.size.width },
      lines: outcome.lines,
      source,
    };
    const response = await this.#request(`/${hash}/text/${key}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    if (!response.ok) throw new Error(`${key}: status ${response.status}`);
    this.#keep(hash, key, (await response.json()) as TextResult);
  }
}
