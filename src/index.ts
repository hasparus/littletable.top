import {
  AVATAR_HEADER,
  type AvatarSource,
  type BoardRoom,
  PASS_HEADER,
  PUBLIC_BOARD,
  type Refusal,
} from "./board-room";
import { MAX_CHAT_LENGTH, MAX_CHAT_MESSAGES_PER_MINUTE } from "./chat";
import { type Config, type ConfigEnv, ConfigError, readConfig } from "./config";
import { parseLaunch, parsePool } from "./dice";
import { notationPool, parseNotation } from "./dice-notation";
import { readCapped } from "./file-store";
import { serveFiles } from "./files";
import { addressKey } from "./limiter";
import {
  type Pass,
  publicKeyFrom,
  type Verifier,
  verifyDeletion,
  verifyLinkReset,
  verifyPass,
} from "./pass";
import { aliasRedirect, serveSite } from "./site";
import { type Keys, keysFrom, passVerifier } from "./standalone/keys";
import { Standalone, type StandaloneEnv } from "./standalone/routes";

export { BoardRoom } from "./board-room";
export { Limiter } from "./limiter";

// DB and Limiter are bound in standalone mode only.
export type Env = ConfigEnv &
  Partial<Pick<StandaloneEnv, "DB" | "Limiter">> & {
    ASSETS: Fetcher;
    BoardRoom: DurableObjectNamespace<BoardRoom>;
    Files: R2Bucket;
  };

// NOTE: the pass travels in the request itself, never in a cookie. The
// client is served from this origin, so the rooms API needs no CORS:
// another origin's page can neither read an answer nor send a pass it has.
const REFUSAL_STATUS: Record<Refusal, number> = { full: 429, "link-reset": 403, "too-fast": 429 };

function answer(result: Refusal | object): Response {
  return typeof result === "string"
    ? new Response(result, { status: REFUSAL_STATUS[result] })
    : Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

type Verifiers = {
  deletion: Verifier | null;
  keys: Keys | null;
  linkReset: Verifier | null;
  pass: Verifier;
};

async function verifiersFor(config: Config): Promise<Verifiers> {
  if (config.mode === "standalone") {
    const keys = await keysFrom(config.signingKey).catch(() => {
      throw new ConfigError("SIGNING_KEY is not an RSA private key in PKCS#8 PEM form");
    });
    return { deletion: null, keys, linkReset: null, pass: passVerifier(keys) };
  }
  const key = await publicKeyFrom(config.publicKey).catch(() => {
    throw new ConfigError("ISSUER_PUBLIC_KEY is not a public key in SPKI PEM form");
  });
  return {
    deletion: { audience: config.deletionAudience, issuer: config.issuer, key },
    keys: null,
    linkReset: { audience: config.linkResetAudience, issuer: config.issuer, key },
    pass: { audience: config.passAudience, issuer: config.issuer, key },
  };
}

const bearer = (request: Request) =>
  request.headers.get("Authorization")?.replace(/^Bearer /u, "") ?? null;

async function passFor(request: Request, verifier: Verifier, board: string) {
  return verifiedPass(
    bearer(request) ?? new URL(request.url).searchParams.get("pass"),
    verifier,
    board,
  );
}

async function verifiedPass(token: string | null, verifier: Verifier, board: string) {
  if (token === null) return null;
  try {
    const pass: Pass = await verifyPass(token, verifier);
    return pass.board === board ? pass : null;
  } catch {
    return null;
  }
}

async function mayDelete(request: Request, verifier: Verifier | null, board: string) {
  const token = bearer(request);
  if (token === null || verifier === null) return false;
  try {
    return (await verifyDeletion(token, verifier)) === board;
  } catch {
    return false;
  }
}

async function newLinkOf(request: Request, verifier: Verifier | null, board: string) {
  const token = bearer(request);
  if (token === null || verifier === null) return null;
  try {
    const reset = await verifyLinkReset(token, verifier);
    return reset.board === board ? reset.link : null;
  } catch {
    return null;
  }
}

const ROOMS = /^\/rooms\//u;
// A board's files: its images and their text readings, the cookie, and
// people's pictures (src/files.ts tells them apart).
const FILES = /^\/rooms\/([\w-]{1,64})\/files(?:\/([\w./-]{1,160}))?$/u;

const avatarSource = (config: Config): AvatarSource =>
  config.mode === "hosted"
    ? { hostOrigin: config.hostOrigin, mode: "hosted" }
    : { mode: "standalone" };

async function rooms(
  request: Request,
  env: Env,
  config: Config,
  verifiers: Verifiers,
): Promise<Response> {
  const url = new URL(request.url);
  const [, filesOf, file] = FILES.exec(url.pathname) ?? [];
  if (filesOf !== undefined) {
    return serveFiles(
      request,
      {
        avatars: avatarSource(config),
        board: filesOf,
        bucket: env.Files,
        config,
        passOf: (token) => verifiedPass(token, verifiers.pass, filesOf),
        room: env.BoardRoom.get(env.BoardRoom.idFromName(filesOf)),
      },
      file,
    );
  }
  const [, board, action] =
    /^\/rooms\/([\w-]{1,64})\/(chat|connect|delete|link|rolls?)$/u.exec(url.pathname) ?? [];
  if (
    board === undefined ||
    (action === "chat" && (config.mode !== "standalone" || board !== PUBLIC_BOARD)) ||
    (config.mode === "standalone" &&
      board === PUBLIC_BOARD &&
      (action === "delete" || action === "link"))
  ) {
    return new Response("Not found", { status: 404 });
  }
  const room = env.BoardRoom.get(env.BoardRoom.idFromName(board));
  if (action === "delete") {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!(await mayDelete(request, verifiers.deletion, board))) {
      return new Response("Forbidden", { status: 403 });
    }
    await room.destroy(board);
    return new Response(null, { status: 204 });
  }
  if (action === "link") {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const link = await newLinkOf(request, verifiers.linkReset, board);
    if (link === null) return new Response("Forbidden", { status: 403 });
    await room.moveLink(board, link);
    return new Response(null, { status: 204 });
  }
  const pass = await passFor(request, verifiers.pass, board);
  if (pass === null) return new Response("Forbidden", { status: 403 });

  if (action === "chat") {
    if (request.method === "GET") return answer(await room.chatHistory(pass));
    if (request.method !== "POST" || env.Limiter === undefined)
      return new Response(null, { status: 404 });
    const key = await addressKey(request);
    const limiter = env.Limiter.get(env.Limiter.idFromName(key));
    if (!(await limiter.take("public-chat", MAX_CHAT_MESSAGES_PER_MINUTE, 60_000))) {
      return answer("too-fast");
    }
    const body = await readCapped(request.body, {
      declared: Number(request.headers.get("Content-Length")),
      max: 4 * MAX_CHAT_LENGTH,
    });
    if (body === "too-large") return new Response(null, { status: 413 });
    const text = new TextDecoder().decode(body).trim();
    if (text === "" || text.length > MAX_CHAT_LENGTH) return new Response(null, { status: 400 });
    return answer(await room.sendChat(pass, text));
  }

  if (action === "connect" && request.headers.get("Upgrade") === "websocket") {
    if (url.searchParams.get("sessionId") === null) {
      return new Response("Bad request", { status: 400 });
    }
    const avatar = await room.personAvatar(pass, avatarSource(config));
    const forwarded = new Request(request);
    forwarded.headers.set(PASS_HEADER, JSON.stringify(pass));
    forwarded.headers.set(AVATAR_HEADER, avatar ?? "");
    return room.fetch(forwarded);
  }
  if (action === "rolls" && request.method === "GET") return answer(await room.rolls(pass));
  if (action === "roll" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (typeof body === "object" && body !== null && "expression" in body) {
      if (typeof body.expression !== "string") return new Response("Bad request", { status: 400 });
      const notation = parseNotation(body.expression);
      if (typeof notation === "string") {
        return Response.json({ error: notation }, { status: 400 });
      }
      return answer(await room.roll(pass, notationPool(notation), body.expression.trim()));
    }
    const pool = parsePool(body);
    if (pool === null) return new Response("Bad request", { status: 400 });
    const requestedLaunch = (body as { launch?: unknown } | null)?.launch;
    const launch = requestedLaunch === undefined ? undefined : parseLaunch(requestedLaunch);
    if (launch === null || (launch !== undefined && pool.length !== 1)) {
      return new Response("Bad request", { status: 400 });
    }
    return answer(await room.roll(pass, pool, undefined, launch));
  }
  return new Response("Not found", { status: 404 });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  let config: Config;
  let verifiers: Verifiers;
  try {
    config = readConfig(env);
    verifiers = await verifiersFor(config);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(JSON.stringify({ event: "tabletop.misconfigured", problem: error.message }));
    return new Response("This tabletop is not configured", { status: 500 });
  }
  const moved = aliasRedirect(request, config.hosts);
  if (moved !== null) return moved;
  if (ROOMS.test(new URL(request.url).pathname)) return rooms(request, env, config, verifiers);
  if (config.mode === "standalone") {
    if (env.DB === undefined || env.Limiter === undefined) {
      console.error(
        JSON.stringify({ event: "tabletop.misconfigured", problem: "no DB or Limiter" }),
      );
      return new Response("This tabletop is not configured", { status: 500 });
    }
    const own = new Standalone(
      { BoardRoom: env.BoardRoom, DB: env.DB, Files: env.Files, Limiter: env.Limiter },
      config,
      verifiers.keys!,
    ).route(request);
    if (own !== null) return own;
  }
  return serveSite(request, env.ASSETS, config, env.DB);
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
