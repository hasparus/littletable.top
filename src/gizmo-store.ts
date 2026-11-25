import { readCapped, sha256Hex, sniff } from "./file-store";
import {
  gizmoSource,
  isPackageAssetPath,
  normalizeManifest,
  installedManifestSchema,
} from "./gizmo-packages";
import { imageDimensions } from "./image-size";

type Source = NonNullable<ReturnType<typeof gizmoSource>>;
type FetchFile = (url: string, init: RequestInit) => Promise<Response>;
type Stored = { url: string; manifest: string };
const problem = (status: number, error: string) => ({ error, status });
const MAX_PACKAGES = 32;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

function deserialize(row: Stored) {
  const manifest = installedManifestSchema.validate(JSON.parse(row.manifest));
  return { url: row.url, manifest };
}

export function readInstalledGizmo(sql: SqlStorage, url: string) {
  const row = sql
    .exec<Stored>("SELECT url, manifest FROM gizmo_packages WHERE url = ?", url)
    .toArray()[0];
  return row ? deserialize(row) : null;
}

async function fetchLimited(fetchFile: FetchFile, url: string, max: number) {
  try {
    const response = await fetchFile(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return problem(response.status === 404 ? 404 : 502, "Package download failed");
    }
    const body = await readCapped(response.body, {
      declared: Number(response.headers.get("content-length")),
      max,
    });
    return body === "too-large" ? problem(413, "Package file too large") : body;
  } catch {
    return problem(502, "Package download failed");
  }
}

async function loadManifest(fetchFile: FetchFile, source: Source, board: string) {
  const body = await fetchLimited(fetchFile, source.rawManifest, MAX_MANIFEST_BYTES);
  if (!(body instanceof ArrayBuffer)) return body;
  const key = await sha256Hex(new TextEncoder().encode(source.url).buffer);
  const prefix = "/rooms/" + board + "/gizmo-assets/" + key + "/";
  const paths = new Set<string>();
  try {
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const manifest = normalizeManifest(json, (path) => {
      paths.add(path);
      return prefix + path;
    });
    return { key, manifest, paths: [...paths] };
  } catch {
    return problem(422, "Invalid Gizmo manifest");
  }
}

export class GizmoStore {
  private readonly pending = new Map<string, ReturnType<typeof loadManifest>>();
  constructor(
    private readonly sql: SqlStorage,
    private readonly fetchFile: FetchFile,
  ) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gizmo_packages (url TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL, paths TEXT NOT NULL)",
    );
  }

  list() {
    return this.sql
      .exec<Stored>("SELECT url, manifest FROM gizmo_packages ORDER BY rowid")
      .toArray()
      .map(deserialize);
  }

  private full() {
    return (
      this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM gizmo_packages").one().n >=
      MAX_PACKAGES
    );
  }

  async install(board: string, input: string, authorized: () => boolean) {
    if (!authorized()) return problem(403, "Forbidden");
    const source = gizmoSource(input);
    if (!source) return problem(400, "Use a GitHub gizmo.json URL pinned to a full commit");
    const existing = readInstalledGizmo(this.sql, source.url);
    if (existing) return existing;
    let pending = this.pending.get(source.url);
    if (!pending) {
      if (this.pending.size >= 4 || this.full()) return problem(429, "Package capacity reached");
      pending = loadManifest(this.fetchFile, source, board).finally(() =>
        this.pending.delete(source.url),
      );
      this.pending.set(source.url, pending);
    }
    const loaded = await pending;
    if (!authorized()) return problem(403, "Forbidden");
    if ("error" in loaded) return loaded;
    const installed = readInstalledGizmo(this.sql, source.url);
    if (installed) return installed;
    if (this.full()) return problem(429, "Package capacity reached");
    this.sql.exec(
      "INSERT INTO gizmo_packages(url, key, manifest, paths) VALUES (?, ?, ?, ?)",
      source.url,
      loaded.key,
      JSON.stringify(loaded.manifest),
      JSON.stringify(loaded.paths),
    );
    return { url: source.url, manifest: loaded.manifest };
  }

  private assetSource(key: string, path: string) {
    if (!isPackageAssetPath(path)) return null;
    const row = this.sql
      .exec<{ url: string }>(
        "SELECT url FROM gizmo_packages WHERE key = ? AND EXISTS (SELECT 1 FROM json_each(paths) WHERE value = ?)",
        key,
        path,
      )
      .toArray()[0];
    if (!row) return null;
    const source = gizmoSource(row.url);
    return source ? source.rawDirectory + path : null;
  }

  async image(key: string, path: string, head: boolean) {
    const url = this.assetSource(key, path);
    if (url === null) return new Response(null, { status: 404 });
    const body = await fetchLimited(this.fetchFile, url, MAX_IMAGE_BYTES);
    if (!(body instanceof ArrayBuffer)) return new Response(body.error, { status: body.status });
    const bytes = new Uint8Array(body);
    const type = sniff(bytes.subarray(0, 32));
    if (type !== "image/webp" && type !== "image/jpeg" && type !== "image/png")
      return new Response(null, { status: 415 });
    const dimensions = imageDimensions(bytes);
    if (!dimensions || dimensions.width > 4096 || dimensions.height > 4096)
      return new Response(null, { status: 415 });
    return new Response(head ? null : body, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(body.byteLength),
        "Content-Type": type,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
