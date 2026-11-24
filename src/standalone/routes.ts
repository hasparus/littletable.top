// Standalone mode's own routes: sign-in through the provider, the account's
// session, its boards, and the pass endpoint, which answers exactly as a
// host's does (docs/hosting.md, "The host contract") so the client cannot tell the
// two apart. Passes are signed with the Worker's own key.

import type { BoardRoom } from "../board-room";
import type { StandaloneConfig } from "../config";
import type { Limiter } from "../limiter";
import type { SignInProvider } from "./provider";

import { avatarKey, copyAvatar, logAvatar, providerRule } from "../avatars";
import { serveStored } from "../files";
import { addressKey } from "../limiter";
import {
  MAX_BOARDS_PER_ACCOUNT,
  MAX_BOARDS_PER_HOUR,
  MAX_PASSES_PER_MINUTE,
  MAX_SIGN_INS_PER_MINUTE,
} from "../limits";
import { cleanName, cleanTitle } from "../names";
import { type Keys, seal, signPass, unseal } from "./keys";
import { ProviderError } from "./provider";
import { type Session, Store } from "./store";
import { workOs } from "./workos";

export type StandaloneEnv = {
  BoardRoom: DurableObjectNamespace<BoardRoom>;
  DB: D1Database;
  Files: R2Bucket;
  Limiter: DurableObjectNamespace<Limiter>;
};

// NOTE: __Host- cookies are Secure, host-only and on path /, so neither a
// sibling subdomain nor a plain-HTTP page can set or read them.
const SESSION_COOKIE = "__Host-tabletop-session";
const SIGN_IN_COOKIE = "__Host-tabletop-sign-in";
const GUEST_COOKIE = "__Host-tabletop-guest";
const PUBLIC_GUEST_COOKIE = "__Host-tabletop-public-guest";
// Account boards have random alphanumeric IDs, so their rooms cannot collide.
const PUBLIC_BOARD = "public-lobby";

const SESSION_LIFETIME_S = 30 * 24 * 60 * 60;
const SIGN_IN_LIFETIME_S = 10 * 60;
const GUEST_LIFETIME_S = 365 * 24 * 60 * 60;
const SIGN_IN_AUDIENCE = "tabletop-sign-in";
const GUEST_AUDIENCE = "tabletop-guest";

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// Rejection sampling keeps every character equally likely.
function randomCode(length: number): string {
  let code = "";
  const byte = new Uint8Array(1);
  while (code.length < length) {
    crypto.getRandomValues(byte);
    if (byte[0]! < 248) code += ALPHANUMERIC[byte[0]! % 62];
  }
  return code;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCodePoint(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

const now = () => Math.floor(Date.now() / 1000);

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

const json = (status: number, body: object, headers: HeadersInit = {}) =>
  Response.json(body, { headers: { "Cache-Control": "no-store", ...headers }, status });

const refuse = (status: number, error: string) => json(status, { error });

// A same-origin page's request, never a form or a page elsewhere: the
// browser names the origin on every POST, and a JSON body needs a
// preflight no other origin passes.
function sameOrigin(request: Request): boolean {
  return (
    request.headers.get("Origin") === new URL(request.url).origin &&
    request.headers.get("Content-Type")?.split(";")[0] === "application/json"
  );
}

// A return address on this origin only, so sign-in cannot be made to
// redirect elsewhere.
function returnPath(value: string | null): string {
  return value !== null && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}

export class Standalone {
  private readonly provider: SignInProvider;
  private readonly store: Store;

  constructor(
    private readonly env: StandaloneEnv,
    private readonly config: StandaloneConfig,
    private readonly keys: Keys,
  ) {
    this.provider = workOs(config.workOs);
    this.store = new Store(env.DB);
  }

  // The routes this mode adds, or null for any other path.
  route(request: Request): Promise<Response> | null {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (pathname === "/auth/sign-in" && method === "GET") return this.signIn(request);
    if (pathname === "/auth/callback" && method === "GET") return this.callback(request);
    if (pathname === "/auth/sign-out" && method === "POST") return this.signOut(request);
    if (pathname === "/api/me" && method === "GET") return this.me(request);
    const picture = /^\/api\/avatars\/([0-9a-f]{64})$/u.exec(pathname);
    if (picture !== null && (method === "GET" || method === "HEAD")) {
      return this.avatar(request, picture[1]!);
    }
    if (pathname === "/api/boards" && method === "GET") return this.list(request);
    if (pathname === "/api/boards" && method === "POST") return this.create(request);
    if (pathname === "/api/public-board/bootstrap" && method === "POST") {
      return this.bootstrap(request, null);
    }
    const action = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/(rename|reset|delete)$/u.exec(pathname);
    if (action !== null && method === "POST") return this.act(request, action[1]!, action[2]!);
    const door = /^\/api\/b\/([A-Za-z0-9]{1,64})\/bootstrap$/u.exec(pathname);
    if (door !== null && method === "POST") return this.bootstrap(request, door[1]!);
    if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
      return Promise.resolve(refuse(404, "not-found"));
    }
    return null;
  }

  private async allowed(request: Request, bucket: string, limit: number): Promise<boolean> {
    const key = await addressKey(request);
    return this.env.Limiter.get(this.env.Limiter.idFromName(key)).take(bucket, limit, 60_000);
  }

  private async session(request: Request): Promise<{ hash: string; session: Session } | null> {
    const token = cookie(request, SESSION_COOKIE);
    if (token === null) return null;
    const hash = await sha256(token);
    const session = await this.store.session(hash, now());
    return session === null ? null : { hash, session };
  }

  // A signed-in person's state-changing request: same origin, and the
  // session's CSRF token echoed in a header.
  private async member(request: Request) {
    if (!sameOrigin(request)) return { refusal: refuse(403, "forbidden-origin") } as const;
    const found = await this.session(request);
    if (found === null) return { refusal: refuse(401, "signed-out") } as const;
    if (request.headers.get("X-CSRF-Token") !== found.session.csrf) {
      return { refusal: refuse(403, "csrf") } as const;
    }
    return found;
  }

  private async signIn(request: Request): Promise<Response> {
    if (!(await this.allowed(request, "sign-in", MAX_SIGN_INS_PER_MINUTE))) {
      return new Response("Too many sign-ins. Wait a minute.", { status: 429 });
    }
    const url = new URL(request.url);
    const state = randomToken();
    const verifier = randomToken();
    const sealed = await seal(
      this.keys,
      SIGN_IN_AUDIENCE,
      { back: returnPath(url.searchParams.get("return")), state, verifier },
      SIGN_IN_LIFETIME_S,
    );
    const location = this.provider.authorizationUrl({
      codeChallenge: await challengeOf(verifier),
      redirectUri: `${url.origin}/auth/callback`,
      state,
    });
    return new Response(null, {
      headers: {
        Location: location,
        "Set-Cookie": setCookie(SIGN_IN_COOKIE, sealed, SIGN_IN_LIFETIME_S),
      },
      status: 302,
    });
  }

  private async callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const failed = (reason: string) => {
      log("auth.sign_in_failed", { reason });
      return new Response(null, {
        headers: {
          Location: "/boards?sign-in=failed",
          "Set-Cookie": setCookie(SIGN_IN_COOKIE, "", 0),
        },
        status: 302,
      });
    };
    const sealed = cookie(request, SIGN_IN_COOKIE);
    const started = sealed === null ? null : await unseal(this.keys, SIGN_IN_AUDIENCE, sealed);
    if (started === null) return failed("no-sign-in-in-progress");
    if (url.searchParams.get("state") !== started.state) return failed("state-mismatch");
    const code = url.searchParams.get("code");
    if (code === null) return failed(url.searchParams.get("error") ?? "no-code");
    let identity;
    try {
      identity = await this.provider.exchange({
        clientIp: request.headers.get("CF-Connecting-IP") ?? "",
        code,
        codeVerifier: String(started.verifier),
        redirectUri: `${url.origin}/auth/callback`,
        userAgent: request.headers.get("User-Agent") ?? "",
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return failed(error.message);
    }
    const signedIn = now();
    const account = await this.store.signIn(
      { ...identity, name: cleanName(identity.name) ?? "Player" },
      await this.accountAvatar(identity),
      signedIn,
    );
    const token = randomToken();
    await this.store.openSession({
      accountId: account.id,
      csrf: randomToken(),
      expiresAt: signedIn + SESSION_LIFETIME_S,
      now: signedIn,
      providerSession: identity.providerSession,
      tokenHash: await sha256(token),
    });
    log("auth.signed_in", { account: account.id });
    const headers = new Headers({ Location: returnPath(String(started.back)) });
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, token, SESSION_LIFETIME_S));
    headers.append("Set-Cookie", setCookie(SIGN_IN_COOKIE, "", 0));
    return new Response(null, { headers, status: 302 });
  }

  // The account's picture after this sign-in: the copy it has while the
  // provider's address stays the same, else a fresh copy, else none. A
  // failed copy is tried again at the next sign-in.
  private async accountAvatar(identity: { avatarUrl: string | null; subject: string }) {
    if (identity.avatarUrl === null) return null;
    const kept = await this.store.avatarOf(identity.subject);
    if (kept.avatarUrl === identity.avatarUrl && kept.avatar !== null) return kept.avatar;
    const copy = await copyAvatar({
      bucket: this.env.Files,
      rule: providerRule(this.config.workOs.apiBase),
      url: identity.avatarUrl,
    });
    logAvatar({ copy, mode: "standalone", person: "member" });
    return "hash" in copy ? copy.hash : null;
  }

  // The signed-in person's own picture, for the front page; nobody else's.
  private async avatar(request: Request, hash: string): Promise<Response> {
    const found = await this.session(request);
    if (found === null || found.session.account.avatar !== hash) {
      return new Response("Not found", { status: 404 });
    }
    return serveStored(request, {
      bucket: this.env.Files,
      config: this.config,
      key: avatarKey(hash),
      name: hash,
    });
  }

  private async signOut(request: Request): Promise<Response> {
    const found = await this.member(request);
    if ("refusal" in found) return found.refusal;
    await this.store.closeSession(found.hash);
    log("auth.signed_out", { account: found.session.account.id });
    const { origin } = new URL(request.url);
    const redirect =
      this.provider.signOutUrl({
        providerSession: found.session.providerSession,
        returnTo: `${origin}/`,
      }) ?? "/";
    return json(200, { redirect }, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }

  private async me(request: Request): Promise<Response> {
    const found = await this.session(request);
    if (found === null) return json(200, { account: null, csrf: null });
    const { account, csrf } = found.session;
    const avatar = account.avatar === null ? null : `/api/avatars/${account.avatar}`;
    return json(200, { account: { avatar, id: account.id, name: account.name }, csrf });
  }

  private async list(request: Request): Promise<Response> {
    const found = await this.session(request);
    if (found === null) return refuse(401, "signed-out");
    return json(200, await this.store.list(found.session.account.id));
  }

  private async create(request: Request): Promise<Response> {
    const found = await this.member(request);
    if ("refusal" in found) return found.refusal;
    const owner = found.session.account.id;
    const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
    const title = cleanTitle(body?.title);
    if (title === null) return refuse(400, "title-invalid");
    if ((await this.store.countBoards(owner)) >= MAX_BOARDS_PER_ACCOUNT) {
      return refuse(409, "too-many-boards");
    }
    if ((await this.store.boardsCreatedSince(owner, now() - 3600)) >= MAX_BOARDS_PER_HOUR) {
      return refuse(429, "too-many-requests");
    }
    const board = await this.store.createBoard({
      createdAt: now(),
      id: randomCode(12),
      ownerId: owner,
      shareCode: randomCode(22),
      title,
    });
    log("board.created", { account: owner, board: board.id });
    return json(201, { id: board.id, shareCode: board.shareCode, title: board.title });
  }

  // Owner-only: a board that is not this account's answers as if it did
  // not exist, and nothing changes.
  private async act(request: Request, id: string, action: string): Promise<Response> {
    const found = await this.member(request);
    if ("refusal" in found) return found.refusal;
    const owner = found.session.account.id;
    const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
    if (action === "rename") {
      const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
      const title = cleanTitle(body?.title);
      if (title === null) return refuse(400, "title-invalid");
      const renamed = await this.store.rename(id, owner, title);
      if (renamed === null) return refuse(404, "not-found");
      log("board.renamed", { account: owner, board: id });
      return json(200, { id, shareCode: renamed.shareCode, title: renamed.title });
    }
    if (action === "reset") {
      const reset = await this.store.resetLink(id, owner, randomCode(22));
      if (reset === null) return refuse(404, "not-found");
      await room.moveLink(id, reset.linkVersion);
      return json(200, { id, shareCode: reset.shareCode, title: reset.title });
    }
    if (!(await this.store.delete(id, owner))) return refuse(404, "not-found");
    await room.destroy(id);
    return new Response(null, { status: 204 });
  }

  // The host contract's pass endpoint, answered by the Worker itself.
  private async bootstrap(request: Request, code: string | null): Promise<Response> {
    if (!sameOrigin(request)) return refuse(403, "forbidden-origin");
    if (!(await this.allowed(request, "pass", MAX_PASSES_PER_MINUTE))) {
      return refuse(429, "too-many-requests");
    }
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    if (body === null || typeof body !== "object") return refuse(400, "invalid-request");
    const saved = code === null ? null : await this.store.byShareCode(code);
    if (code !== null && saved === null) return refuse(404, "not-found");
    const board = saved ?? { id: PUBLIC_BOARD, linkVersion: 0, title: this.config.displayName };
    const found = await this.session(request);
    const headers = new Headers({ "Cache-Control": "no-store" });
    let person: { avatar: string | null; id: string; name: string; owner: boolean };
    if (found === null) {
      const guestCookie = code === null ? PUBLIC_GUEST_COOKIE : GUEST_COOKIE;
      const kept = cookie(request, guestCookie);
      const guest = kept === null ? null : await unseal(this.keys, GUEST_AUDIENCE, kept);
      let name = typeof guest?.name === "string" ? guest.name : null;
      if (body.name !== undefined) {
        name = cleanName(body.name);
        if (name === null) return refuse(422, "name-invalid");
      }
      if (name === null && code !== null) return refuse(422, "name-required");
      const id = typeof guest?.sub === "string" ? guest.sub : `g:${randomCode(16)}`;
      name ??= `Guest ${id.slice(2, 6)}`;
      person = { avatar: null, id, name, owner: false };
      const sealed = await seal(this.keys, GUEST_AUDIENCE, { name, sub: id }, GUEST_LIFETIME_S);
      headers.append("Set-Cookie", setCookie(guestCookie, sealed, GUEST_LIFETIME_S));
    } else {
      const { account } = found.session;
      const owner = saved?.ownerId === account.id;
      person = { avatar: account.avatar, id: `a:${account.id}`, name: account.name, owner };
      if (!owner && saved !== null) await this.store.visit(account.id, saved, now());
    }
    const pass = await signPass(this.keys, {
      avatar: person.avatar,
      board: board.id,
      link: board.linkVersion,
      name: person.name,
      owner: person.owner,
      sub: person.id,
    });
    log("pass.issued", {
      board: board.id,
      owner: person.owner,
      person: found ? "member" : "guest",
    });
    return Response.json(
      {
        board: board.id,
        boardsUrl: found === null ? null : "/boards",
        home: { name: this.config.displayName, url: "/" },
        pass,
        person: { id: person.id, name: person.name, owner: person.owner },
        title: board.title,
      },
      { headers, status: 200 },
    );
  }
}
