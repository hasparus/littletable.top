import type { ChatMessage } from "./chat";
import type { ExpressionError } from "./dice-expression";
import type { Roll } from "./dice-notation";

import { frontView } from "../client/src/front-page";
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
import { type FeedbackEnv, feedbackRoute } from "./feedback";
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
import { isSecretLayer, secretLayerOf } from "./secret-layer";
import { aliasRedirect, serveFront, serveSite } from "./site";
import { type Keys, keysFrom, passVerifier } from "./standalone/keys";
import { Standalone, type StandaloneEnv } from "./standalone/routes";
import { hasActiveSession } from "./standalone/store";
import { canSummon, MAX_SUMMON_BYTES, type SummonRequest, summonRequest } from "./summon";

export { BoardRoom } from "./board-room";
export { Limiter } from "./limiter";

/** The standalone deployment alone binds D1 and the address limiter. */
export type Env = ConfigEnv &
  FeedbackEnv &
  Partial<Pick<StandaloneEnv, "BOARD_DATA_SCOPE" | "DB" | "Limiter">> & {
    ASSETS: Fetcher;
    BoardRoom: DurableObjectNamespace<BoardRoom>;
    Files: R2Bucket;
  };

const REFUSAL_STATUS: Record<Refusal, number> = { full: 429, "link-reset": 403, "too-fast": 429 };

function answer(result: Refusal | object): Response {
  return typeof result === "string"
    ? new Response(result, { status: REFUSAL_STATUS[result] })
    : Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

function answerRoll(result: Refusal | ChatMessage | Roll | { error: ExpressionError }) {
  if (typeof result !== "string" && "error" in result) {
    return Response.json(result, { status: 400 });
  }
  return answer(result);
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
const FILES = /^\/rooms\/([\w-]{1,64}(?:\/secret)?)\/files(?:\/([\w./-]{1,160}))?$/u;
const ACTION = /^\/rooms\/([\w-]{1,64}(?:\/secret)?)\/(chat|connect|delete|link|rolls?|summon)$/u;

const avatarSource = (config: Config): AvatarSource =>
  config.mode === "hosted"
    ? { hostOrigin: config.hostOrigin, mode: "hosted" }
    : { mode: "standalone" };

async function summon(request: Request, room: DurableObjectStub<BoardRoom>, pass: Pass) {
  if (request.method !== "POST" || isSecretLayer(pass.board)) {
    return new Response(null, { status: 404 });
  }
  if (!canSummon(pass)) return new Response(null, { status: 403 });
  const body = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length")),
    max: MAX_SUMMON_BYTES,
  });
  if (body === "too-large") return new Response(null, { status: 413 });
  let destination: SummonRequest;
  try {
    destination = summonRequest.validate(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response(null, { status: 400 });
  }
  const refusal = await room.summon(pass, destination);
  if (refusal === "page-missing" || refusal === "participant-missing")
    return new Response(null, { status: 409 });
  return refusal === null ? new Response(null, { status: 204 }) : answer(refusal);
}

async function chat(
  request: Request,
  room: DurableObjectStub<BoardRoom>,
  pass: Pass,
  limiter: Env["Limiter"],
) {
  if (request.method === "GET") return answer(await room.chatHistory(pass));
  if (request.method !== "POST") return new Response(null, { status: 404 });
  const address = limiter?.get(limiter.idFromName(await addressKey(request)));
  if (address && !(await address.take("chat", MAX_CHAT_MESSAGES_PER_MINUTE, 60_000))) {
    return answer("too-fast");
  }
  const body = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length")),
    max: 4 * MAX_CHAT_LENGTH,
  });
  if (body === "too-large") return new Response(null, { status: 413 });
  const text = new TextDecoder().decode(body).trim();
  if (text === "" || text.length > MAX_CHAT_LENGTH) return new Response(null, { status: 400 });
  return answerRoll(await room.sendChat(pass, text));
}

async function rooms(
  request: Request,
  env: Env,
  config: Config,
  verifiers: Verifiers,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, filesOf, file] = FILES.exec(url.pathname) ?? [];
  const [, board = filesOf, action] = ACTION.exec(url.pathname) ?? [];
  if (board === undefined) return new Response("Not found", { status: 404 });
  const secret = isSecretLayer(board);
  if (action === "chat" && secret) return new Response("Not found", { status: 404 });
  if (secret && (config.mode !== "standalone" || board === secretLayerOf(PUBLIC_BOARD))) {
    return new Response("Not found", { status: 404 });
  }
  if (
    (action === "delete" || action === "link") &&
    (secret || (config.mode === "standalone" && board === PUBLIC_BOARD))
  ) {
    return new Response("Not found", { status: 404 });
  }
  const passOf = async (token: string | null) => {
    const pass = await verifiedPass(token, verifiers.pass, board);
    if (!secret) return pass;
    return pass?.owner === true && (await hasActiveSession(env.DB, pass.sessionHash)) ? pass : null;
  };
  const room = env.BoardRoom.get(env.BoardRoom.idFromName(board));
  if (filesOf !== undefined) {
    return serveFiles(
      request,
      {
        avatars: avatarSource(config),
        board: filesOf,
        bucket: env.Files,
        config,
        ctx,
        passOf,
        room,
        secret,
      },
      file,
    );
  }
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
  const pass = await passOf(bearer(request) ?? url.searchParams.get("pass"));
  if (pass === null) return new Response("Forbidden", { status: 403 });
  if (action === "summon") return summon(request, room, pass);

  if (action === "chat") {
    // WARNING: Only the public board's guests are free to make, so only it limits each address; elsewhere a table on one network would share one limit.
    return chat(request, room, pass, board === PUBLIC_BOARD ? env.Limiter : undefined);
  }

  if (action === "connect" && request.headers.get("Upgrade") === "websocket") {
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId === null || sessionId.length > 128) {
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
      return answerRoll(await room.roll(pass, { expression: body.expression }));
    }
    const pool = parsePool(body);
    if (pool === null) return new Response("Bad request", { status: 400 });
    const requestedLaunch = (body as { launch?: unknown } | null)?.launch;
    const launch = requestedLaunch === undefined ? undefined : parseLaunch(requestedLaunch);
    if (launch === null || (launch !== undefined && pool.length !== 1)) {
      return new Response("Bad request", { status: 400 });
    }
    return answerRoll(await room.roll(pass, { dice: pool, launch }));
  }
  return new Response("Not found", { status: 404 });
}

async function routeRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
  const { pathname } = new URL(request.url);
  if (ROOMS.test(pathname)) return rooms(request, env, config, verifiers, ctx);
  if (config.mode === "standalone") {
    if (env.DB === undefined || env.Limiter === undefined) {
      console.error(
        JSON.stringify({ event: "tabletop.misconfigured", problem: "no DB or Limiter" }),
      );
      return new Response("This tabletop is not configured", { status: 500 });
    }
    if (pathname === "/api/feedback") return feedbackRoute(request, env, env.Limiter);
    const own = new Standalone(
      {
        BOARD_DATA_SCOPE: env.BOARD_DATA_SCOPE,
        BoardRoom: env.BoardRoom,
        DB: env.DB,
        Files: env.Files,
        Limiter: env.Limiter,
      },
      config,
      verifiers.keys!,
    );
    const view = frontView(pathname);
    if (
      view !== null &&
      (view !== "assistants" || config.assistants === true) &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return serveFront(request, env.ASSETS, config, own, view);
    }
    const route = own.route(request);
    if (route !== null) return route;
  }
  return serveSite(request, env, config);
}

function quotaRoute(path: string) {
  if (path.startsWith("/auth/")) return "auth";
  if (path.startsWith("/b/") || path.startsWith("/api/b/")) return "share";
  if (path.startsWith("/p/")) return "published-image";
  if (ROOMS.test(path)) return "room";
  if (path.startsWith("/api/")) return "api";
  return "site";
}

export async function handle(request: Request, env: Env, ctx?: ExecutionContext) {
  try {
    return await routeRequest(request, env, ctx);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Exceeded allowed duration in Durable Objects free tier."
    ) {
      throw error;
    }
    const path = new URL(request.url).pathname;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const retry = Math.ceil((day - (now % day)) / 1000);
    const headers = { "Cache-Control": "no-store", "Retry-After": String(retry) };
    const route = quotaRoute(path);
    console.error(JSON.stringify({ event: "tabletop.daily-server-limit", route }));
    return route === "auth"
      ? new Response("Little Table reached its daily server limit. Try again after 00:00 UTC.", {
          headers,
          status: 503,
        })
      : Response.json({ error: "daily-server-limit" }, { headers, status: 503 });
  }
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
