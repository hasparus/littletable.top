import { decodeJwt } from "jose";

import type { AvatarSource, BoardRoom } from "./board-room";
import type { Config } from "./config";
import type { Pass } from "./pass";

import { avatarKey } from "./avatars";
import { fileKey, readCapped, textKey } from "./file-store";
import { MAX_FILE_BYTES, MAX_TEXT_RESULT_BYTES } from "./limits";
import { harden } from "./site";
import { type EngineKey, isEngineKey } from "./text-result";
import { parseClaim } from "./text-store";

/** Carries the read pass for `<img>` loads, which cannot send an Authorization header. */
export const FILE_COOKIE = "tabletop-files";

const HASH = /^[0-9a-f]{64}$/u;

export const filesPath = (board: string) => `/rooms/${board}/files`;

type FileRoute = {
  avatars: AvatarSource;
  board: string;
  bucket: R2Bucket;
  config: Config;
  passOf: (token: string | null) => Promise<Pass | null>;
  room: DurableObjectStub<BoardRoom>;
  secret: boolean;
};

const UPLOAD_STATUS = {
  empty: 400,
  "link-reset": 403,
  "over-quota": 507,
  "too-fast": 429,
  "too-large": 413,
  unsupported: 415,
} as const;

type Outcome = "duplicate" | "forbidden" | "stored" | keyof typeof UPLOAD_STATUS;

function logUpload(fields: {
  board: string;
  bytes: number | null;
  outcome: Outcome;
  pass: Pass | null;
  type: string | null;
}) {
  const { board, bytes, outcome, pass, type } = fields;
  const person = pass === null ? null : pass.sub.startsWith("g:") ? "guest" : "member";
  console.log(JSON.stringify({ board, bytes, event: "board.file_upload", outcome, person, type }));
}

const refuse = (status: number, error: string) =>
  Response.json({ error }, { headers: { "Cache-Control": "no-store" }, status });

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

const bearer = (request: Request) =>
  request.headers.get("Authorization")?.replace(/^Bearer /u, "") ?? null;

async function upload(request: Request, route: FileRoute): Promise<Response> {
  const { board, room } = route;
  const pass = await route.passOf(bearer(request));
  if (pass === null) {
    logUpload({ board, bytes: null, outcome: "forbidden", pass, type: null });
    return refuse(403, "forbidden");
  }
  const body = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length") ?? "0"),
    max: MAX_FILE_BYTES,
  });
  if (body === "too-large") {
    logUpload({ board, bytes: null, outcome: body, pass, type: null });
    return refuse(UPLOAD_STATUS[body], body);
  }
  const result = await room.storeFile(pass, body);
  if (typeof result === "string") {
    logUpload({ board, bytes: body.byteLength, outcome: result, pass, type: null });
    return refuse(UPLOAD_STATUS[result], result);
  }
  const { bytes, duplicate, hash, type } = result;
  logUpload({ board, bytes, outcome: duplicate ? "duplicate" : "stored", pass, type });
  return Response.json(
    { bytes, hash, src: `${filesPath(board)}/${hash}`, type },
    { headers: { "Cache-Control": "no-store" }, status: duplicate ? 200 : 201 },
  );
}

// Trades the pass in the header for the same pass in a cookie on the
// board's files path, for as long as the pass lives, and answers where the
// person's own picture is (the room copies a host's on the way).
async function access(request: Request, route: FileRoute): Promise<Response> {
  const token = bearer(request);
  const pass = await route.passOf(token);
  if (token === null || pass === null) return refuse(403, "forbidden");
  if ((await route.room.fileAccess(pass)) !== null) return refuse(403, "link-reset");
  const avatar = await route.room.personAvatar(pass, route.avatars);
  // NOTE: verified, a pass always carries exp.
  const lifetime = Math.max(0, decodeJwt(token).exp! - Math.floor(Date.now() / 1000));
  return Response.json(
    { avatar: avatar === null ? null : `${filesPath(route.board)}/avatars/${avatar}` },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": `${FILE_COOKIE}=${token}; Max-Age=${lifetime}; Path=${filesPath(route.board)}; Secure; HttpOnly; SameSite=Strict`,
      },
    },
  );
}

// WARNING: Treat a directly opened upload as a document. This policy keeps SVG scripts inert.
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function contentRange(range: R2Range | undefined, size: number): string | null {
  if (range === undefined) return null;
  let offset: number;
  let length: number;
  if ("suffix" in range && range.suffix !== undefined) {
    length = Math.min(range.suffix, size);
    offset = size - length;
  } else {
    const bounded = range as { length?: number; offset?: number };
    offset = bounded.offset ?? 0;
    length = bounded.length ?? size - offset;
  }
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}

/**
 * Serves an upload or avatar with its detected media type and supports byte
 * ranges. Direct navigation applies the same script and resource restrictions.
 */
export async function serveStored(
  request: Request,
  {
    bucket,
    config,
    key,
    name,
    secret = false,
  }: { bucket: R2Bucket; config: Config; key: string; name: string; secret?: boolean },
): Promise<Response> {
  let object: R2Object | R2ObjectBody | null;
  try {
    object =
      request.method === "HEAD"
        ? await bucket.head(key)
        : await bucket.get(key, { onlyIf: request.headers, range: request.headers });
  } catch {
    return new Response("Range not satisfiable", { status: 416 });
  }
  if (object === null) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // WARNING: Browsers must reauthorize every secret image read, even for immutable content.
  headers.set("Cache-Control", secret ? "no-store" : "private, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  const type = object.httpMetadata?.contentType ?? "application/octet-stream";
  headers.set(
    "Content-Disposition",
    type === "image/svg+xml" ? `attachment; filename="${name}.svg"` : "inline",
  );
  let response: Response;
  if ("body" in object) {
    const range = request.headers.has("Range") ? contentRange(object.range, object.size) : null;
    if (range !== null) headers.set("Content-Range", range);
    response = new Response(object.body as ReadableStream, {
      headers,
      status: range === null ? 200 : 206,
    });
  } else {
    // HEAD, or a GET whose If-None-Match already holds these bytes.
    const unchanged = request.method === "GET";
    if (!unchanged) headers.set("Content-Length", String(object.size));
    response = new Response(null, { headers, status: unchanged ? 304 : 200 });
  }
  const hardened = harden(response, request, config);
  hardened.headers.set("Content-Security-Policy", FILE_POLICY);
  return hardened;
}

async function reader(request: Request, route: FileRoute): Promise<Pass | null> {
  const pass = await route.passOf(bearer(request) ?? cookie(request, FILE_COOKIE));
  if (pass === null) return null;
  return (await route.room.fileAccess(pass)) === null ? pass : null;
}

async function read(request: Request, route: FileRoute, hash: string): Promise<Response> {
  if ((await reader(request, route)) === null) return new Response("Forbidden", { status: 403 });
  return serveStored(request, {
    bucket: route.bucket,
    config: route.config,
    key: fileKey(route.board, hash),
    name: hash,
    secret: route.secret,
  });
}

// A picture of someone who has been on this board, to anyone on it now.
async function readAvatar(request: Request, route: FileRoute, hash: string): Promise<Response> {
  if ((await reader(request, route)) === null) return new Response("Forbidden", { status: 403 });
  if (!(await route.room.hasAvatar(hash))) return new Response("Not found", { status: 404 });
  return serveStored(request, {
    bucket: route.bucket,
    config: route.config,
    key: avatarKey(hash),
    name: hash,
    secret: route.secret,
  });
}

const TEXT_STATUS = {
  invalid: 422,
  "link-reset": 403,
  "over-quota": 507,
  "too-fast": 429,
  "unknown-image": 404,
  unreadable: 422,
} as const;

const fresh = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" }, status });

async function jsonBody(request: Request, max: number): Promise<unknown> {
  const body = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length") ?? "0"),
    max,
  });
  if (body === "too-large") return null;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function leaseOf(body: unknown): { failed: EngineKey[]; lease: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { failed = [], lease } = body as Record<string, unknown>;
  if (typeof lease !== "string" || lease.length > 64) return null;
  if (
    !Array.isArray(failed) ||
    !failed.every((key) => typeof key === "string" && isEngineKey(key))
  ) {
    return null;
  }
  return { failed: failed as EngineKey[], lease };
}

function logText(fields: {
  board: string;
  engine: string;
  outcome: string;
  pass: Pass | null;
  problem?: string;
  words: number | null;
}) {
  const { pass, ...rest } = fields;
  const person = pass === null ? null : pass.sub.startsWith("g:") ? "guest" : "member";
  console.log(JSON.stringify({ event: "board.text_stored", ...rest, person }));
}

async function textControl(request: Request, route: FileRoute, action: string): Promise<Response> {
  if (action === "" && (request.method === "GET" || request.method === "HEAD")) {
    const pass = await reader(request, route);
    if (pass === null) return refuse(403, "forbidden");
    const listing = await route.room.textListing(pass);
    return typeof listing === "string" ? refuse(403, listing) : fresh(listing);
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const pass = await route.passOf(bearer(request));
  if (pass === null) return refuse(403, "forbidden");
  const body = await jsonBody(request, 256 * 1024);
  if (action === "/claim") {
    const claim = parseClaim(body);
    if (claim === null) return refuse(400, "invalid");
    const result = await route.room.claimText(pass, claim);
    if (result === null) return new Response(null, { status: 204 });
    if (typeof result === "string") return refuse(result === "too-fast" ? 429 : 403, result);
    return fresh(result);
  }
  const held = leaseOf(body);
  if (held === null) return refuse(400, "invalid");
  if (action === "/renew") {
    const renewed = await route.room.renewText(pass, held.lease);
    if (renewed === "link-reset") return refuse(403, renewed);
    return renewed ? new Response(null, { status: 204 }) : refuse(409, "lease-expired");
  }
  if (action === "/release") {
    const released = await route.room.releaseText(pass, held.lease, held.failed);
    return released === null ? new Response(null, { status: 204 }) : refuse(403, released);
  }
  return new Response("Not found", { status: 404 });
}

async function storeText(
  request: Request,
  route: FileRoute,
  reading: { engine: EngineKey; hash: string },
): Promise<Response> {
  const { board } = route;
  const pass = await route.passOf(bearer(request));
  if (pass === null) return refuse(403, "forbidden");
  const body = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length") ?? "0"),
    max: MAX_TEXT_RESULT_BYTES,
  });
  if (body === "too-large") {
    logText({ board, engine: reading.engine, outcome: body, pass, words: null });
    return refuse(413, body);
  }
  const stored = await route.room.storeText(pass, reading, body);
  if (typeof stored === "string") {
    logText({ board, engine: reading.engine, outcome: stored, pass, words: null });
    return refuse(TEXT_STATUS[stored], stored);
  }
  if ("problem" in stored) {
    logText({
      board,
      engine: reading.engine,
      outcome: "invalid",
      pass,
      problem: stored.problem,
      words: null,
    });
    return Response.json(
      { error: "invalid", problem: stored.problem },
      { headers: { "Cache-Control": "no-store" }, status: 422 },
    );
  }
  logText({
    board,
    engine: reading.engine,
    outcome: stored.duplicate ? "duplicate" : "stored",
    pass,
    words: stored.words,
  });
  return new Response(stored.body, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    status: stored.duplicate ? 200 : 201,
  });
}

async function readText(
  request: Request,
  route: FileRoute,
  { engine, hash }: { engine: EngineKey; hash: string },
): Promise<Response> {
  if ((await reader(request, route)) === null) return new Response("Forbidden", { status: 403 });
  // WARNING: Immutable caching assumes a stored text result is never overwritten.
  return serveStored(request, {
    bucket: route.bucket,
    config: route.config,
    key: textKey(route.board, hash, engine),
    name: hash,
    secret: route.secret,
  });
}

const TEXT_OF = /^([0-9a-f]{64})\/text\/([\w.-]{1,40})$/u;

export function serveFiles(
  request: Request,
  route: FileRoute,
  file: string | undefined,
): Promise<Response> {
  const { method } = request;
  if (file === undefined && method === "POST") return upload(request, route);
  if (file === "access" && method === "POST") return access(request, route);
  const control = /^text(|\/claim|\/renew|\/release)$/u.exec(file ?? "");
  if (control !== null) return textControl(request, route, control[1]!);
  const [, textOf, engine = ""] = TEXT_OF.exec(file ?? "") ?? [];
  if (textOf !== undefined && isEngineKey(engine)) {
    if (method === "PUT") return storeText(request, route, { engine, hash: textOf });
    if (method === "GET" || method === "HEAD")
      return readText(request, route, { engine, hash: textOf });
  }
  const avatar = /^avatars\/([0-9a-f]{64})$/u.exec(file ?? "");
  if (avatar !== null && (method === "GET" || method === "HEAD")) {
    return readAvatar(request, route, avatar[1]!);
  }
  if (file !== undefined && HASH.test(file) && (method === "GET" || method === "HEAD")) {
    return read(request, route, file);
  }
  return Promise.resolve(new Response("Not found", { status: 404 }));
}
