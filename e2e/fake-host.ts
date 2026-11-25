// WARNING: This in-memory sample host signs passes with the committed development key. Use it only locally.

import { importPKCS8, SignJWT } from "jose";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { pictureOf } from "./fake-workos.ts";

const PORT = Number(process.env.FAKE_HOST_PORT ?? 8000);
const TABLETOP = process.env.TABLETOP_ORIGIN ?? "http://localhost:8788";
const ISSUER = "dev-host";
const PASS_LIFETIME_S = 300;
const MAX_NAME_LENGTH = 40;

const signingKey = await importPKCS8(
  readFileSync(new URL("../dev/dev-signing-key.pem", import.meta.url), "utf8"),
  "RS256",
);

type Board = { code: string; id: string; link: number; owner: string; title: string };
type Member = { avatar: string | null; id: string; name: string };
type Session = { guest?: { id: string; name: string }; member?: Member };

const boards = new Map<string, Board>();
const sessions = new Map<string, Session>();
let nextMember = 1;
let nextBoard = 1;

const token = (bytes: number) => randomBytes(bytes).toString("base64url").replaceAll(/[-_]/gu, "");

function sessionOf(request: IncomingMessage, response: ServerResponse): Session {
  const id = /(?:^|;\s*)host_session=([\w-]+)/u.exec(request.headers.cookie ?? "")?.[1];
  if (id !== undefined && sessions.has(id)) return sessions.get(id)!;
  const fresh = token(18);
  const session: Session = {};
  sessions.set(fresh, session);
  // WARNING: Keep the host and tabletop on the same site. A port change is fine, but a site change blocks this Lax cookie.
  response.setHeader("Set-Cookie", `host_session=${fresh}; Path=/; HttpOnly; SameSite=Lax`);
  return session;
}

function json(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function page(response: ServerResponse, html: string) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><title>Fake host</title>${html}`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const cleanName = (name: string) => name.split(/\s+/u).filter(Boolean).join(" ");

const now = () => Math.floor(Date.now() / 1000);

function signPass(
  board: Board,
  person: { avatar: string | null; id: string; name: string; owner: boolean },
) {
  return new SignJWT({
    ...(person.avatar === null ? {} : { avatar: person.avatar }),
    board: board.id,
    link: board.link,
    name: person.name,
    owner: person.owner,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience("board")
    .setSubject(person.id)
    .setIssuedAt(now())
    .setExpirationTime(now() + PASS_LIFETIME_S)
    .sign(signingKey);
}

function signBoardCommand(audience: string, claims: { board: string; link?: number }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(now())
    .setExpirationTime(now() + 60)
    .sign(signingKey);
}

function answerTabletop(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", TABLETOP);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
}

async function bootstrap(request: IncomingMessage, response: ServerResponse, code: string) {
  if (request.headers.origin !== TABLETOP) {
    return json(response, 403, { error: "forbidden-origin" });
  }
  answerTabletop(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Max-Age": "600",
    });
    return response.end();
  }
  if (request.headers["content-type"] !== "application/json") {
    return json(response, 415, { error: "invalid-request" });
  }
  let body: { name?: unknown };
  try {
    const text = await readBody(request);
    body = text === "" ? {} : (JSON.parse(text) as { name?: unknown });
  } catch {
    return json(response, 400, { error: "invalid-request" });
  }
  const board = [...boards.values()].find((candidate) => candidate.code === code);
  if (board === undefined) return json(response, 404, { error: "not-found" });
  const session = sessionOf(request, response);
  let person: { avatar: string | null; id: string; name: string; owner: boolean };
  if (session.member === undefined) {
    if (typeof body.name === "string") {
      const name = cleanName(body.name);
      if (name === "" || name.length > MAX_NAME_LENGTH) {
        return json(response, 422, { error: "name-invalid" });
      }
      session.guest = { id: session.guest?.id ?? `g:${token(12)}`, name };
    }
    if (session.guest === undefined) return json(response, 422, { error: "name-required" });
    person = { ...session.guest, avatar: null, owner: false };
  } else {
    person = { ...session.member, owner: board.owner === session.member.id };
  }
  return json(response, 200, {
    board: board.id,
    boardsUrl: session.member ? `http://localhost:${PORT}/boards/` : null,
    home: { name: "Fake host", url: `http://localhost:${PORT}/` },
    pass: await signPass(board, person),
    person: { id: person.id, name: person.name, owner: person.owner },
    title: board.title,
  });
}

function boardsPage(response: ServerResponse, session: Session) {
  if (session.member === undefined) return page(response, `<p>Not signed in.</p>`);
  const mine = [...boards.values()].filter((board) => board.owner === session.member!.id);
  const rows = mine
    .map(
      (board) => `<li><a href="${TABLETOP}/b/${board.code}">${board.title}</a>
        <form method="post" action="/boards/${board.id}/reset"><button>Reset link of ${board.title}</button></form>
        <form method="post" action="/boards/${board.id}/delete"><button>Delete ${board.title}</button></form></li>`,
    )
    .join("");
  page(
    response,
    `<h1>My boards</h1><form method="post" action="/boards/new"><button>New board</button></form><ul>${rows}</ul>`,
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const contract = /^\/b\/([A-Za-z0-9]+)\/bootstrap\/$/u.exec(url.pathname);
  if (contract !== null) return bootstrap(request, response, contract[1]!);
  const picture = /^\/avatars\/(u-\d+)\.png$/u.exec(url.pathname);
  if (picture !== null && request.method === "GET") {
    response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "image/png" });
    return response.end(pictureOf(picture[1]!));
  }
  const session = sessionOf(request, response);
  if (url.pathname === "/sign-in") {
    const name = url.searchParams.get("name") ?? "Member";
    const id = nextMember++;
    const avatar =
      url.searchParams.get("picture") === "none"
        ? null
        : `http://localhost:${PORT}/avatars/u-${id}.png`;
    session.member = { avatar, id: `u:${id}`, name };
    response.writeHead(302, { Location: "/boards/" });
    return response.end();
  }
  if (url.pathname === "/boards/" && request.method === "GET") return boardsPage(response, session);
  if (url.pathname === "/" && request.method === "GET") return page(response, "<h1>Fake host</h1>");
  if (session.member === undefined || request.method !== "POST") {
    response.writeHead(404);
    return response.end();
  }
  if (url.pathname === "/boards/new") {
    const id = String(nextBoard++);
    const board = { code: token(12), id, link: 0, owner: session.member.id, title: `Board ${id}` };
    boards.set(id, board);
    response.writeHead(302, { Location: `${TABLETOP}/b/${board.code}` });
    return response.end();
  }
  const action = /^\/boards\/(\d+)\/(reset|delete)$/u.exec(url.pathname);
  const board = action === null ? undefined : boards.get(action[1]!);
  if (board === undefined || board.owner !== session.member.id) {
    response.writeHead(404);
    return response.end();
  }
  if (action![2] === "reset") {
    board.code = token(12);
    board.link += 1;
    const resetToken = await signBoardCommand("board-link-reset", {
      board: board.id,
      link: board.link,
    });
    const reset = await fetch(`${TABLETOP}/rooms/${board.id}/link`, {
      headers: { Authorization: `Bearer ${resetToken}` },
      method: "POST",
    }).catch(() => null);
    if (reset?.status !== 204) return json(response, 502, { error: "link-reset-unconfirmed" });
  } else {
    boards.delete(board.id);
    const wiped = await fetch(`${TABLETOP}/rooms/${board.id}/delete`, {
      headers: {
        Authorization: `Bearer ${await signBoardCommand("board-deletion", { board: board.id })}`,
      },
      method: "POST",
    });
    if (wiped.status !== 204) console.error("fake host: the tabletop did not wipe", wiped.status);
  }
  response.writeHead(302, { Location: "/boards/" });
  return response.end();
});

server.listen(PORT, () => console.log(`fake host on http://localhost:${PORT}`));
