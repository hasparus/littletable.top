// A stand-in for the three WorkOS AuthKit endpoints the tabletop calls, so
// the whole sign-in runs offline: in Vitest as the Worker's outbound fetch
// handler (vitest.config.ts) and in Playwright as a server (this file run
// with node). Test-only. It checks what WorkOS would check: the client id
// and secret, the redirect URI, the code's single use, and PKCE.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const FAKE_CLIENT_ID = "client_fake";
export const FAKE_API_KEY = "sk_test_fake";

type Grant = { challenge: string; id: string; name: string; redirectUri: string };

const grants = new Map<string, Grant>();

const base64url = (bytes: Buffer) => bytes.toString("base64url");

const userId = (name: string) =>
  `user_${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;

// The access token is only read for its `sid`, so it goes unsigned here.
const accessToken = (sid: string) =>
  `${base64url(Buffer.from('{"alg":"none"}'))}.${base64url(Buffer.from(JSON.stringify({ sid })))}.`;

function page(body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Fake WorkOS</title>${body}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function grant(url: URL, name: string, id: string): Response {
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const code = base64url(randomBytes(12));
  grants.set(code, {
    challenge: url.searchParams.get("code_challenge") ?? "",
    id,
    name,
    redirectUri,
  });
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", url.searchParams.get("state") ?? "");
  return Response.redirect(back.toString(), 302);
}

export async function fakeWorkOs(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/user_management/authorize") {
    if (url.searchParams.get("client_id") !== FAKE_CLIENT_ID) {
      return new Response("unknown client", { status: 400 });
    }
    // A test can skip the page and name the person in the address, and tell
    // apart two people of one name with fake_id.
    const name = url.searchParams.get("fake_user");
    if (name !== null) return grant(url, name, url.searchParams.get("fake_id") ?? name);
    const hidden = [...url.searchParams]
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${key}" value="${value.replaceAll('"', "&quot;")}">`,
      )
      .join("");
    return page(
      `<form method="get" action="/user_management/authorize">${hidden}<label>Name <input name="fake_user" required></label><button>Continue</button></form>`,
    );
  }
  if (url.pathname === "/user_management/authenticate" && request.method === "POST") {
    const body = (await request.json()) as Record<string, string>;
    const held = grants.get(body.code ?? "");
    grants.delete(body.code ?? "");
    const verifier = createHash("sha256")
      .update(body.code_verifier ?? "")
      .digest("base64url");
    if (
      body.client_id !== FAKE_CLIENT_ID ||
      body.client_secret !== FAKE_API_KEY ||
      body.grant_type !== "authorization_code" ||
      held === undefined ||
      verifier !== held.challenge
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const [first = held.name, ...rest] = held.name.split(" ");
    return Response.json({
      access_token: accessToken(`session_${base64url(randomBytes(8))}`),
      refresh_token: "unused",
      user: {
        email: `${first.toLowerCase()}@example.test`,
        first_name: first,
        id: userId(held.id),
        last_name: rest.join(" ") || null,
        object: "user",
        profile_picture_url: null,
      },
    });
  }
  if (url.pathname === "/user_management/sessions/logout") {
    return Response.redirect(url.searchParams.get("return_to") ?? "/", 302);
  }
  return new Response("not found", { status: 404 });
}

const PORT = Number(process.env.FAKE_WORKOS_PORT ?? 8001);

if (process.argv[1]?.endsWith("fake-workos.ts")) {
  createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const request = new Request(`http://localhost:${PORT}${incoming.url ?? "/"}`, {
      body: incoming.method === "POST" ? Buffer.concat(chunks) : undefined,
      headers: incoming.headers as Record<string, string>,
      method: incoming.method,
    });
    const response = await fakeWorkOs(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }).listen(PORT, () => console.log(`fake WorkOS on http://localhost:${PORT}`));
}
