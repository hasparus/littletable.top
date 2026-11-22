// A board's images over HTTP: uploads, the cookie an <img> reads them with,
// and the reads. See README, "Images".

import { decodeJwt } from "jose";

import type { BoardRoom } from "./board-room";
import type { Config } from "./config";
import type { Pass } from "./pass";

import { fileKey } from "./file-store";
import { MAX_FILE_BYTES } from "./limits";
import { harden } from "./site";

// NOTE: an <img> cannot send an Authorization header. The pass rides in
// this cookie instead, scoped to the board's files, for reads only.
export const FILE_COOKIE = "tabletop-files";

const HASH = /^[0-9a-f]{64}$/u;

export const filesPath = (board: string) => `/rooms/${board}/files`;

type FileRoute = {
  board: string;
  bucket: R2Bucket;
  config: Config;
  // The verified pass in the request, from the header or (for reads) the
  // cookie, or null when there is none for this board.
  passOf: (token: string | null) => Promise<Pass | null>;
  room: DurableObjectStub<BoardRoom>;
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

// The body, up to the cap: a larger one is cut off as soon as it shows,
// whatever its Content-Length said.
async function readCapped(request: Request): Promise<"too-large" | ArrayBuffer> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_FILE_BYTES) return "too-large";
  if (request.body === null) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_FILE_BYTES) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body.buffer;
}

async function upload(request: Request, route: FileRoute): Promise<Response> {
  const { board, room } = route;
  const pass = await route.passOf(bearer(request));
  if (pass === null) {
    logUpload({ board, bytes: null, outcome: "forbidden", pass, type: null });
    return refuse(403, "forbidden");
  }
  const body = await readCapped(request);
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
// board's files path, for as long as the pass lives.
async function access(request: Request, route: FileRoute): Promise<Response> {
  const token = bearer(request);
  const pass = await route.passOf(token);
  if (token === null || pass === null) return refuse(403, "forbidden");
  if ((await route.room.fileAccess(pass)) !== null) return refuse(403, "link-reset");
  // NOTE: verified, a pass always carries exp.
  const lifetime = Math.max(0, decodeJwt(token).exp! - Math.floor(Date.now() / 1000));
  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": `${FILE_COOKIE}=${token}; Max-Age=${lifetime}; Path=${filesPath(route.board)}; Secure; HttpOnly; SameSite=Strict`,
    },
    status: 204,
  });
}

// NOTE: an image opened on its own is a document of this origin. It runs
// no script and loads nothing; an SVG is also handed over as a download.
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

async function read(request: Request, route: FileRoute, hash: string): Promise<Response> {
  const pass = await route.passOf(bearer(request) ?? cookie(request, FILE_COOKIE));
  if (pass === null) return new Response("Forbidden", { status: 403 });
  if ((await route.room.fileAccess(pass)) !== null) {
    return new Response("Forbidden", { status: 403 });
  }
  const key = fileKey(route.board, hash);
  let object: R2Object | R2ObjectBody | null;
  try {
    object =
      request.method === "HEAD"
        ? await route.bucket.head(key)
        : await route.bucket.get(key, { onlyIf: request.headers, range: request.headers });
  } catch {
    return new Response("Range not satisfiable", { status: 416 });
  }
  if (object === null) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // Content-addressed: the bytes at this address never change.
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  const type = object.httpMetadata?.contentType ?? "application/octet-stream";
  headers.set(
    "Content-Disposition",
    type === "image/svg+xml" ? `attachment; filename="${hash}.svg"` : "inline",
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
  const hardened = harden(response, request, route.config);
  hardened.headers.set("Content-Security-Policy", FILE_POLICY);
  return hardened;
}

export function serveFiles(
  request: Request,
  route: FileRoute,
  file: string | undefined,
): Promise<Response> {
  const { method } = request;
  if (file === undefined && method === "POST") return upload(request, route);
  if (file === "access" && method === "POST") return access(request, route);
  if (file !== undefined && HASH.test(file) && (method === "GET" || method === "HEAD")) {
    return read(request, route, file);
  }
  return Promise.resolve(new Response("Not found", { status: 404 }));
}
