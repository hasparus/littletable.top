import { readCapped, sha256Hex, sniff } from "./file-store";
import {
  gizmoSource,
  normalizeGizmoLink,
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

async function pinSource(fetchFile: FetchFile, input: string) {
  const link = normalizeGizmoLink(input);
  if (!link) return problem(400, "Use a GitHub folder or gizmo.json link");
  const pinned = gizmoSource(link);
  if (pinned) return pinned;
  const [, owner, repo, , ...parts] = new URL(link).pathname.split("/");
  const signal = AbortSignal.timeout(8000);
  for (let split = 1; split < parts.length; split++) {
    const ref = encodeURIComponent(parts.slice(0, split).join("/"));
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
    const response = await fetchFile(url, {
      headers: { Accept: "application/vnd.github.sha", "User-Agent": "Little-Table-Gizmos" },
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([404, 422].includes(response.status)) continue;
      return problem(502, "GitHub revision lookup failed");
    }
    const bytes = await readCapped(response.body, {
      max: 128,
      declared: Number(response.headers.get("content-length")),
    });
    if (!(bytes instanceof ArrayBuffer)) return problem(502, "Invalid GitHub revision");
    const sha = new TextDecoder().decode(bytes).trim();
    if (!/^[a-f\d]{40}$/u.test(sha)) return problem(502, "Invalid GitHub revision");
    const source = gizmoSource(
      `https://github.com/${owner}/${repo}/blob/${sha}/${parts.slice(split).join("/")}`,
    );
    if (source) return source;
  }
  return problem(404, "GitHub revision unavailable");
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

  async install(
    board: string,
    input: string,
    authorized: () => boolean,
    onInstalled?: (url: string) => void,
  ) {
    if (!authorized()) return problem(403, "Forbidden");
    const source = await pinSource(this.fetchFile, input).catch(() =>
      problem(502, "GitHub revision lookup failed"),
    );
    if (!authorized()) return problem(403, "Forbidden");
    if ("error" in source) return source;
    const existing = readInstalledGizmo(this.sql, source.url);
    if (existing) {
      onInstalled?.(existing.url);
      return existing;
    }
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
    if (installed) {
      onInstalled?.(installed.url);
      return installed;
    }
    if (this.full()) return problem(429, "Package capacity reached");
    this.sql.exec(
      "INSERT INTO gizmo_packages(url, key, manifest, paths) VALUES (?, ?, ?, ?)",
      source.url,
      loaded.key,
      JSON.stringify(loaded.manifest),
      JSON.stringify(loaded.paths),
    );
    onInstalled?.(source.url);
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
