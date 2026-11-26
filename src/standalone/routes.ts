import { animals, colors, uniqueNamesGenerator } from "unique-names-generator";

import type { StandaloneConfig } from "../config";
import type { Limiter } from "../limiter";
import type { Role } from "../pass";
import type { SignInProvider } from "./provider";

import { avatarKey, copyAvatar, logAvatar, providerRule } from "../avatars";
import { type BoardRoom, PUBLIC_BOARD } from "../board-room";
import { isThumbnailType, thumbnailByteLimit } from "../board-thumbnail";
import { publicationKey, readCapped, sniff } from "../file-store";
import { serveStored } from "../files";
import { imageDimensions } from "../image-size";
import { addressKey } from "../limiter";
import {
  MAX_BOARDS_PER_ACCOUNT,
  MAX_BOARDS_PER_HOUR,
  MAX_FILE_BYTES,
  MAX_NAME_LENGTH,
  MAX_PASSES_PER_MINUTE,
  MAX_SIGN_INS_PER_MINUTE,
} from "../limits";
import { cleanName, cleanTitle } from "../names";
import { secretLayerOf } from "../secret-layer";
import { harden } from "../site";
import { isThumbnail, thumbnailKey } from "../thumbnail-store";
import { AssistantGrants } from "./assistant-grants";
import { assistantsPage } from "./assistants-page";
import { type Keys, seal, signPass, unseal } from "./keys";
import { ProviderError } from "./provider";
import { type Session, Store } from "./store";
import { workOs } from "./workos";

export type StandaloneEnv = {
  BOARD_DATA_SCOPE?: string;
  BoardRoom: DurableObjectNamespace<BoardRoom>;
  DB: D1Database;
  Files: R2Bucket;
  Limiter: DurableObjectNamespace<Limiter>;
};

// WARNING: Keep the __Host- prefix so sibling subdomains and insecure pages cannot set the session cookie.
const SESSION_COOKIE = "__Host-tabletop-session";
const SIGN_IN_COOKIE = "__Host-tabletop-sign-in";
const GUEST_COOKIE = "__Host-tabletop-guest";
const PUBLIC_GUEST_COOKIE = "__Host-tabletop-public-guest";

const SESSION_LIFETIME_S = 30 * 24 * 60 * 60;
const SIGN_IN_LIFETIME_S = 10 * 60;
const GUEST_LIFETIME_S = 365 * 24 * 60 * 60;
const SIGN_IN_AUDIENCE = "tabletop-sign-in";
const GUEST_AUDIENCE = "tabletop-guest";

const PUBLIC_GUEST_COLORS = colors.filter((word) => word.length <= 12);
const PUBLIC_GUEST_ANIMALS = animals.filter((word) => word.length < MAX_NAME_LENGTH - 12);

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// WARNING: Taking a random byte modulo the alphabet size would bias share codes.
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

function accountSummary({ account, csrf }: Session) {
  const avatar = account.avatar === null ? null : `/api/avatars/${account.avatar}`;
  return { account: { avatar, id: account.id, name: account.name }, csrf };
}

const json = (status: number, body: object, headers: HeadersInit = {}) =>
  Response.json(body, { headers: { "Cache-Control": "no-store", ...headers }, status });

const refuse = (status: number, error: string) => json(status, { error });

// WARNING: Require same-origin JSON so cross-origin forms cannot submit an authenticated action.
function sameOrigin(request: Request, contentType = "application/json"): boolean {
  return (
    request.headers.get("Origin") === new URL(request.url).origin &&
    request.headers.get("Content-Type")?.split(";")[0] === contentType
  );
}

// WARNING: Accept only a local path so sign-in cannot redirect to another origin.
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
    this.store = new Store(env.DB, env.BOARD_DATA_SCOPE);
  }

  route(request: Request): Promise<Response> | null {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (pathname === "/auth/sign-in" && method === "GET") return this.signIn(request);
    if (pathname === "/auth/callback" && method === "GET") return this.callback(request);
    if (pathname === "/auth/sign-out" && method === "POST") return this.signOut(request);
    if (
      this.config.assistants &&
      pathname === "/assistants" &&
      (method === "GET" || method === "POST")
    ) {
      return this.assistants(request).then((response) => {
        const page = harden(response, request, this.config);
        // WARNING: no-referrer makes native POST navigations send Origin: null.
        if (method === "GET" && page.ok) page.headers.set("Referrer-Policy", "same-origin");
        return page;
      });
    }
    if (pathname === "/api/me" && method === "GET") return this.me(request);
    const picture = /^\/api\/avatars\/([0-9a-f]{64})$/u.exec(pathname);
    if (picture !== null && (method === "GET" || method === "HEAD")) {
      return this.avatar(request, picture[1]!);
    }
    const publication = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/publish$/u.exec(pathname);
    if (publication !== null && (method === "POST" || method === "DELETE")) {
      return this.publish(request, publication[1]!);
    }
    const published = /^\/p\/([A-Za-z0-9]{1,64})\/([a-f0-9-]{36})$/u.exec(pathname);
    if (published !== null && (method === "GET" || method === "HEAD")) {
      return this.published(request, published[1]!, published[2]!);
    }
    const thumbnail = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/thumbnail$/u.exec(pathname);
    if (thumbnail !== null) {
      const id = thumbnail[1]!;
      if (method === "GET" || method === "HEAD") return this.thumbnail(request, id);
      if (method === "PUT") return this.updateThumbnail(request, id);
    }
    if (pathname === "/api/boards" && method === "GET") return this.list(request);
    if (pathname === "/api/boards" && method === "POST") return this.create(request);
    if (pathname === "/api/public-board/bootstrap" && method === "POST") {
      return this.bootstrap(request, null);
    }
    const action = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/(rename|reset|delete)$/u.exec(pathname);
    if (action !== null && method === "POST") return this.act(request, action[1]!, action[2]!);
    const people = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/people$/u.exec(pathname);
    if (people !== null && method === "GET") return this.people(request, people[1]!);
    const role = /^\/api\/boards\/([A-Za-z0-9]{1,64})\/people\/([\w-]{1,128})\/role$/u.exec(
      pathname,
    );
    if (role !== null && method === "POST") return this.setRole(request, role[1]!, role[2]!);
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

  private async member(request: Request, contentType?: string) {
    if (!sameOrigin(request, contentType))
      return { refusal: refuse(403, "forbidden-origin") } as const;
    const found = await this.session(request);
    if (found === null) return { refusal: refuse(401, "signed-out") } as const;
    if (request.headers.get("X-CSRF-Token") !== found.session.csrf) {
      return { refusal: refuse(403, "csrf") } as const;
    }
    return found;
  }

  private async assistants(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const found = await this.session(request);
    if (found === null)
      return Response.redirect(new URL("/auth/sign-in?return=/assistants", url), 302);
    const { account, csrf } = found.session;
    const grants = new AssistantGrants(this.env.DB, this.env.BOARD_DATA_SCOPE);
    if (request.method === "GET") return assistantsPage(grants, account.id, csrf);
    if (
      request.headers.get("Origin") !== url.origin ||
      request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded"
    ) {
      return refuse(403, "forbidden-origin");
    }
    const form = await request.formData().catch(() => null);
    if (form?.get("csrf") !== csrf) return refuse(403, "csrf");
    const client = form.get("client");
    const board = form.get("board");
    const access = form.get("access");
    if (
      typeof client !== "string" ||
      typeof board !== "string" ||
      (access !== "off" && access !== "read" && access !== "write")
    )
      return refuse(400, "invalid-request");
    if (!(await grants.set(account.id, client, board, access))) return refuse(404, "not-found");
    const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(board));
    await room.assistantGrantsChanged();
    return Response.redirect(new URL("/assistants", url), 303);
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

  // WARNING: Retry failed avatar copies at the next sign-in even if the provider URL has not changed.
  private async accountAvatar(identity: { avatarUrl: string | null; subject: string }) {
    if (identity.avatarUrl === null) return null;
    const kept = await this.store.avatarOf(identity.subject);
    if (
      kept.avatarUrl === identity.avatarUrl &&
      kept.avatar !== null &&
      (await this.env.Files.head(avatarKey(kept.avatar))) !== null
    )
      return kept.avatar;
    const copy = await copyAvatar({
      bucket: this.env.Files,
      rule: providerRule(this.config.workOs.apiBase),
      url: identity.avatarUrl,
    });
    logAvatar({ copy, mode: "standalone", person: "member" });
    return "hash" in copy ? copy.hash : null;
  }

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
    const { owned } = await this.store.list(found.session.account.id);
    await Promise.all(
      owned.map(({ id }) => {
        const secret = this.env.BoardRoom.idFromName(secretLayerOf(id));
        return this.env.BoardRoom.get(secret).disconnectSession(found.hash);
      }),
    );
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
    return json(200, accountSummary(found.session));
  }

  async boardPage(request: Request) {
    const found = await this.session(request);
    if (found === null) return "signed-out" as const;
    const lists = await this.store.list(found.session.account.id);
    return { ...accountSummary(found.session), ...lists };
  }

  private async list(request: Request): Promise<Response> {
    const page = await this.boardPage(request);
    return page === "signed-out" ? refuse(401, "signed-out") : json(200, page);
  }

  private async thumbnail(request: Request, id: string): Promise<Response> {
    const found = await this.session(request);
    if (found === null) return refuse(404, "not-found");
    const access = await this.store.thumbnailAccess(id, found.session.account.id);
    if (access?.hasThumbnail !== true) return refuse(404, "not-found");
    return serveStored(request, {
      bucket: this.env.Files,
      config: this.config,
      key: thumbnailKey(id),
      name: id,
      secret: true,
    });
  }

  private async published(request: Request, id: string, code: string) {
    if (!(await this.store.exists(id))) return refuse(404, "not-found");
    const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
    if ((await room.publicationCode()) !== code) return refuse(404, "not-found");
    return serveStored(request, {
      bucket: this.env.Files,
      config: this.config,
      key: publicationKey(id, code),
      name: "page",
      secret: true,
    });
  }

  private async publish(request: Request, id: string) {
    const remove = request.method === "DELETE";
    const found = await this.member(request, remove ? "application/json" : "image/png");
    if ("refusal" in found) return found.refusal;
    if (!(await this.store.owned(id, found.session.account.id))) return refuse(404, "not-found");
    const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
    if (remove) {
      await room.setPublication(id, null);
      return new Response(null, { status: 204 });
    }
    const image = await readCapped(request.body, {
      declared: Number(request.headers.get("Content-Length")),
      max: MAX_FILE_BYTES,
    });
    if (image === "too-large") return refuse(413, "too-large");
    const bytes = new Uint8Array(image);
    if (sniff(bytes) !== "image/png" || imageDimensions(bytes) === null) {
      return refuse(415, "invalid-image");
    }
    const code = await room.setPublication(id, image);
    return code === null ? refuse(404, "not-found") : json(200, { url: `/p/${id}/${code}` });
  }

  private async updateThumbnail(request: Request, id: string): Promise<Response> {
    const type = request.headers.get("Content-Type");
    if (!isThumbnailType(type)) return refuse(415, "invalid-thumbnail");
    const found = await this.member(request, type);
    if ("refusal" in found) return found.refusal;
    const access = await this.store.thumbnailAccess(id, found.session.account.id);
    if (access === null || request.headers.get("X-Board-Link") !== String(access.link)) {
      return refuse(404, "not-found");
    }
    const body = await readCapped(request.body, {
      declared: Number(request.headers.get("Content-Length") ?? "0"),
      max: thumbnailByteLimit(type),
    });
    if (body === "too-large") return refuse(413, "too-large");
    if (!isThumbnail(body, type)) return refuse(415, "invalid-thumbnail");
    const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
    const result = await room.storeThumbnail(id, access.link, body, type);
    if (result === "forbidden") return refuse(404, "not-found");
    if (typeof result === "object") {
      return json(
        429,
        { error: "too-fast" },
        {
          "Retry-After": String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))),
        },
      );
    }
    if (!access.hasThumbnail) await this.store.markThumbnail(id, access.link);
    return new Response(null, { headers: { "Cache-Control": "no-store" }, status: 204 });
  }

  private async create(request: Request): Promise<Response> {
    const found = await this.member(request);
    if ("refusal" in found) return found.refusal;
    const owner = found.session.account.id;
    const body = (await request.json().catch(() => null)) as {
      language?: unknown;
      title?: unknown;
    } | null;
    const title = cleanTitle(body?.title);
    if (title === null) return refuse(400, "title-invalid");
    if ((await this.store.countBoards(owner)) >= MAX_BOARDS_PER_ACCOUNT) {
      return refuse(409, "too-many-boards");
    }
    if ((await this.store.boardsCreatedSince(owner, now() - 3600)) >= MAX_BOARDS_PER_HOUR) {
      return refuse(429, "too-many-requests");
    }
    const id = randomCode(12);
    if (body?.language === "pl") {
      // WARNING: A room opened before seeding gets the default page name instead of the localized one.
      const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
      await room.initializeDrawing("Strona 1");
    }
    const board = await this.store.createBoard({
      createdAt: now(),
      id,
      ownerId: owner,
      shareCode: randomCode(22),
      title,
    });
    log("board.created", { account: owner, board: board.id });
    return json(201, { id: board.id, shareCode: board.shareCode, title: board.title });
  }

  // WARNING: A different account’s board must return the same response as a nonexistent board.
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
      const secret = secretLayerOf(id);
      await Promise.all([
        room.moveLink(id, reset.linkVersion),
        this.env.BoardRoom.get(this.env.BoardRoom.idFromName(secret)).moveLink(
          secret,
          reset.linkVersion,
        ),
      ]);
      return json(200, { id, shareCode: reset.shareCode, title: reset.title });
    }
    if (!(await this.store.beginDeletion(id, owner))) return refuse(404, "not-found");
    const secret = secretLayerOf(id);
    const secretRoom = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(secret));
    // WARNING: Keep the board listed until both rooms have persisted retirement and disconnected their sockets.
    const retirements = await Promise.allSettled([room.markRetired(), secretRoom.markRetired()]);
    for (const result of retirements) if (result.status === "rejected") throw result.reason;
    await this.store.removeBoardForDeletion(id, owner);
    const cleanup = await Promise.allSettled([
      room.wipeRetired(id),
      secretRoom.wipeRetired(secret),
    ]);
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
    await this.env.Files.delete(thumbnailKey(id));
    await this.store.finishDeletion(id, owner);
    return new Response(null, { status: 204 });
  }

  private async people(request: Request, id: string) {
    const found = await this.session(request);
    if (found === null) return refuse(401, "signed-out");
    if ((await this.store.owned(id, found.session.account.id)) === null) {
      return refuse(404, "not-found");
    }
    const people = await this.store.people(id);
    return json(200, {
      people: people.map(({ avatar, id: person, name, role }) => ({
        avatar: avatar === null ? null : `/api/avatars/${avatar}`,
        id: person,
        name,
        role,
      })),
    });
  }

  private async setRole(request: Request, id: string, person: string) {
    const found = await this.member(request);
    if ("refusal" in found) return found.refusal;
    const owner = found.session.account.id;
    const body = await request.json<{ role?: string }>().catch(() => null);
    const role = body?.role;
    if (role !== "write" && role !== "manager") return refuse(400, "role-invalid");
    const board = await this.store.owned(id, owner);
    if (board === null) return refuse(404, "not-found");
    if (!(await this.store.setRole(id, person, role))) return refuse(404, "not-found");
    if (role === "write") {
      const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(id));
      await room.endAssistants(id);
    }
    log("board.role_set", { account: owner, board: id, role });
    return json(200, { id: person, role });
  }

  // WARNING: Keep this response compatible with the hosted pass endpoint so the client can use either mode.
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
    if (code === null) {
      const room = this.env.BoardRoom.get(this.env.BoardRoom.idFromName(PUBLIC_BOARD));
      await room.schedulePublicExpiry();
    }
    const found = await this.session(request);
    const headers = new Headers({ "Cache-Control": "no-store" });
    let person: { avatar: string | null; id: string; name: string; role: Role };
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
      const oldDefault = `Guest ${id.slice(2, 6)}`;
      if (name === null || (code === null && body.name === undefined && name === oldDefault)) {
        name = uniqueNamesGenerator({
          dictionaries: [PUBLIC_GUEST_COLORS, PUBLIC_GUEST_ANIMALS],
          length: 2,
          seed: id,
          separator: " ",
          style: "capital",
        });
      }
      person = { avatar: null, id, name, role: "write" };
      const sealed = await seal(this.keys, GUEST_AUDIENCE, { name, sub: id }, GUEST_LIFETIME_S);
      headers.append("Set-Cookie", setCookie(guestCookie, sealed, GUEST_LIFETIME_S));
    } else {
      const { account } = found.session;
      const owner = (saved?.ownerId ?? this.config.publicBoardOwnerId) === account.id;
      let role: Role = owner ? "owner" : "write";
      if (!owner && saved !== null) {
        await this.store.visit(account.id, saved, now());
        role = (await this.store.roleOf(account.id, saved.id)) ?? "write";
      }
      person = { avatar: account.avatar, id: `a:${account.id}`, name: account.name, role };
    }
    const claims = {
      avatar: person.avatar,
      board: board.id,
      link: board.linkVersion,
      name: person.name,
      owner: person.role === "owner",
      role: person.role,
      sub: person.id,
    };
    const [pass, secretPass, published] = await Promise.all([
      signPass(this.keys, claims),
      person.role === "owner" && saved !== null && found !== null
        ? signPass(this.keys, {
            ...claims,
            board: secretLayerOf(board.id),
            sessionHash: found.hash,
          })
        : null,
      person.role === "owner" && saved !== null
        ? this.env.BoardRoom.get(this.env.BoardRoom.idFromName(board.id)).publicationCode()
        : null,
    ]);
    log("pass.issued", {
      board: board.id,
      owner: person.role === "owner",
      person: found ? "member" : "guest",
      role: person.role,
    });
    return Response.json(
      {
        board: board.id,
        boardsUrl: found === null ? null : "/boards",
        home: { name: this.config.displayName, url: "/" },
        pass,
        person: {
          id: person.id,
          name: person.name,
          owner: person.role === "owner",
          role: person.role,
        },
        ...(secretPass !== null && found !== null
          ? {
              secretPass,
              publication: {
                csrf: found.session.csrf,
                url: published === null ? null : `/p/${board.id}/${published}`,
              },
            }
          : {}),
        ...(saved === null || found === null
          ? {}
          : {
              thumbnail: {
                csrf: found.session.csrf,
                link: saved.linkVersion,
                needed: !saved.hasThumbnail,
              },
            }),
        title: board.title,
      },
      { headers, status: 200 },
    );
  }
}
