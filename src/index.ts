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
import { deckCommand } from "./deck";
import { parseLaunch, parsePool } from "./dice";
import { notationPool, parseNotation } from "./dice-notation";
import { type FeedbackEnv, feedbackRoute } from "./feedback";
import { readCapped } from "./file-store";
import { serveFiles } from "./files";
import { gizmoDecision, gizmoInstallRequest } from "./gizmo-packages";
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
import { aliasRedirect, serveBoards, serveSite } from "./site";
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

const GIZMO_ASSET = /^\/rooms\/([\w-]{1,64})\/gizmo-assets\/([a-f\d]{64})\/([\w./-]{1,240})$/u;
const GIZMO_ACTION =
  /^\/rooms\/([\w-]{1,64}(?:\/secret)?)\/(gizmos|gizmo-requests|deck)$/u;

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

async function rooms(
  request: Request,
  env: Env,
  config: Config,
  verifiers: Verifiers,
): Promise<Response> {
  const url = new URL(request.url);
  const asset = GIZMO_ASSET.exec(url.pathname);
  if (asset) {
    const [, board, key, path] = asset;
    if (board === PUBLIC_BOARD || (request.method !== "GET" && request.method !== "HEAD"))
      return new Response(null, { status: 404 });
    const room = env.BoardRoom.get(env.BoardRoom.idFromName(board!));
    return room.gizmoImage(key!, path!, request.method === "HEAD");
  }
  const [, filesOf, file] = FILES.exec(url.pathname) ?? [];
  const [, board = filesOf, action] = ACTION.exec(url.pathname) ?? GIZMO_ACTION.exec(url.pathname) ?? [];
  if (board === undefined) return new Response("Not found", { status: 404 });
  if (action === "chat" && (config.mode !== "standalone" || board !== PUBLIC_BOARD)) {
    return new Response("Not found", { status: 404 });
  }
  const secret = isSecretLayer(board);
  if (secret && (config.mode !== "standalone" || board === secretLayerOf(PUBLIC_BOARD))) {
    return new Response("Not found", { status: 404 });
  }
  if (
    (action === "delete" || action === "link") &&
    (secret || (config.mode === "standalone" && board === PUBLIC_BOARD))
  ) {
    return new Response("Not found", { status: 404 });
  }
  if (action === "deck" && (secret || board === PUBLIC_BOARD || request.method !== "POST")) {
    return new Response(null, { status: 404 });
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
        passOf,
        room,
        secret,
      },
      file,
    );
  }
  if (action === "gizmos" || action === "gizmo-requests") {
    if (secret || board === PUBLIC_BOARD || (request.method !== "GET" && request.method !== "POST"))
      return new Response(null, { status: 404 });
    const pass = await passOf(bearer(request));
    if (pass === null) return new Response(null, { status: 403 });
    if (request.method === "GET")
      return answer(
        action === "gizmos" ? await room.listGizmos(pass) : await room.listGizmoRequests(pass),
      );
    if (action === "gizmos" && (!pass.owner || pass.sub.startsWith("g:")))
      return new Response(null, { status: 403 });
    const body = await readCapped(request.body, {
      declared: Number(request.headers.get("Content-Length")),
      max: 2048,
    });
    if (body === "too-large") return new Response(null, { status: 413 });
    const input: unknown = await new Response(body).json().catch(() => null);
    const result = gizmoInstallRequest.isValid(input)
      ? action === "gizmos"
        ? await room.installGizmo(pass, input.url)
        : await room.requestGizmo(pass, input.url)
      : action === "gizmo-requests" && gizmoDecision.isValid(input)
        ? await room.reviewGizmo(pass, input)
        : null;
    if (result === null) return new Response(null, { status: 400 });
    return "error" in result
      ? Response.json({ error: result.error }, { status: result.status })
      : answer(result);
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
  if (action === "deck") {
    const body = await readCapped(request.body, {
      declared: Number(request.headers.get("Content-Length")),
      max: 1024,
    });
    if (body === "too-large") return new Response(null, { status: 413 });
    const value: unknown = await new Response(body).json().catch(() => null);
    if (!deckCommand.isValid(value)) return new Response(null, { status: 400 });
    const result = await room.deck(pass, value);
    return result === null ? new Response(null, { status: 409 }) : answer(result);
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
  const { pathname } = new URL(request.url);
  if (ROOMS.test(pathname)) return rooms(request, env, config, verifiers);
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
    if (pathname === "/boards" && (request.method === "GET" || request.method === "HEAD")) {
      return serveBoards(request, env.ASSETS, config, own);
    }
    const route = own.route(request);
    if (route !== null) return route;
  }
  return serveSite(request, env, config);
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
