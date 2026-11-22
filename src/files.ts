// A board's images over HTTP: uploads, the cookie an <img> reads them with,
// and the reads. See README, "Images".

import { decodeJwt } from "jose";

import type { AvatarSource, BoardRoom } from "./board-room";
import type { Config } from "./config";
import type { Pass } from "./pass";

import { avatarKey } from "./avatars";
import { fileKey, readCapped } from "./file-store";
import { MAX_FILE_BYTES } from "./limits";
import { harden } from "./site";

// NOTE: an <img> cannot send an Authorization header. The pass rides in
// this cookie instead, scoped to the board's files, for reads only.
export const FILE_COOKIE = "tabletop-files";

const HASH = /^[0-9a-f]{64}$/u;

export const filesPath = (board: string) => `/rooms/${board}/files`;

type FileRoute = {
  avatars: AvatarSource;
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

// One stored image of R2, as the board serves it: the type it was sniffed
// as, cached for good (the key is the content), ranges, and a policy under
// which it runs and loads nothing when opened on its own. Avatars are
// served through it too.
export async function serveStored(
  request: Request,
  { bucket, config, key, name }: { bucket: R2Bucket; config: Config; key: string; name: string },
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
  // Content-addressed: the bytes at this address never change.
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
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

// The pass a read of the board's files comes with, from the header or the
// cookie, if it is good for the board now.
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
  });
}

export function serveFiles(
  request: Request,
  route: FileRoute,
  file: string | undefined,
): Promise<Response> {
  const { method } = request;
  if (file === undefined && method === "POST") return upload(request, route);
  if (file === "access" && method === "POST") return access(request, route);
  const avatar = /^avatars\/([0-9a-f]{64})$/u.exec(file ?? "");
  if (avatar !== null && (method === "GET" || method === "HEAD")) {
    return readAvatar(request, route, avatar[1]!);
  }
  if (file !== undefined && HASH.test(file) && (method === "GET" || method === "HEAD")) {
    return read(request, route, file);
  }
  return Promise.resolve(new Response("Not found", { status: 404 }));
}
