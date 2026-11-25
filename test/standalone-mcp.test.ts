import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import type { RoomDocumentCalls } from "../src/room-contract";

import { handle } from "../src/mcp/worker";
import { AssistantGrants } from "../src/standalone/assistant-grants";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const issuer = "https://authkit.test";
const resource = "https://mcp.test/mcp";
const boardEnv = { ...standaloneEnv, MCP_RESOURCE: resource };
const { DB, BoardRoom } = env as unknown as { BoardRoom: DurableObjectNamespace; DB: D1Database };
const workerEnv = {
  BoardRoom,
  DB,
  MCP_AUTHORIZATION_SERVER: issuer,
  MCP_BOARD_ORIGIN: ORIGIN,
  MCP_RESOURCE: resource,
};

afterEach(() => vi.unstubAllGlobals());

it("only grants the signed-in owner's chosen client and enforces revocation at the room", async () => {
  const owner = new Browser();
  const other = new Browser();
  await owner.signIn("Ada");
  await other.signIn("Bea");
  const own = await owner.createBoard("Own & <board>");
  const foreign = await other.createBoard("Other board");
  const { account } = await (await owner.fetch("/api/me")).json<{ account: { id: string } }>();
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key" };
  const fetch = vi.fn(async (request: string | URL | Request) => {
    expect(String(request)).toBe(`${issuer}/oauth2/jwks`);
    return Response.json({ keys: [jwk] });
  });
  vi.stubGlobal("fetch", fetch);
  const mint = (clientId: string, audience = resource, profile?: string) =>
    new SignJWT({ client_id: clientId, sid: "consent-1", sub_profile: profile })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setAudience(audience)
      .setIssuer(issuer)
      .setSubject(account.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const call = (token: string) =>
    handle(
      new Request(resource, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search_boards", arguments: {} },
        }),
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      workerEnv,
    );
  const metadata = await handle(
    new Request("https://mcp.test/.well-known/oauth-protected-resource/mcp"),
    workerEnv,
  );
  expect(await metadata.json()).toMatchObject({
    authorization_servers: [issuer],
    resource,
    scopes_supported: ["openid"],
  });
  expect((await call(await mint("wrong-audience", "workos-client"))).status).toBe(401);
  expect((await call(await mint("agent", resource, "ai_agent"))).status).toBe(401);
  const token = await mint("assistant-one");
  const before = await call(token);
  expect(before.status).toBe(200);
  expect(await before.text()).toContain("manageAccess");
  const page = await owner.fetch("/assistants", {}, boardEnv);
  expect(await page.text()).toContain("Own &amp; &lt;board&gt;");
  expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  const update = (board: string, access: string, csrf = owner.csrf ?? "", browser = owner) =>
    browser.fetch(
      "/assistants",
      {
        method: "POST",
        body: new URLSearchParams({ access, board, client: "assistant-one", csrf }),
        headers: { Origin: ORIGIN },
      },
      boardEnv,
    );
  expect((await update(own.id, "write", "invalid")).status).toBe(403);
  expect((await update(foreign.id, "write")).status).toBe(404);
  expect((await update(own.id, "write", other.csrf ?? "", other)).status).toBe(404);
  expect((await update(own.id, "read")).status).toBe(303);
  const granted = await (await call(token)).text();
  expect(granted).toContain(own.id);
  expect(granted).not.toContain(foreign.id);
  expect(await (await call(await mint("assistant-two"))).text()).not.toContain(own.id);

  const [grant] = await new AssistantGrants(DB).grants(account.id, "assistant-one");
  expect(grant?.access).toBe("read");
  const room = BoardRoom.get(BoardRoom.idFromName(own.id)) as unknown as RoomDocumentCalls;
  expect(await room.readDocument(grant!, { scope: "document" })).toMatchObject({
    records: expect.any(Array),
  });
  expect((await update(own.id, "off")).status).toBe(303);
  expect(await room.readDocument(grant!, { scope: "document" })).toBe("revoked");
  expect((await update(own.id, "write")).status).toBe(303);
  expect(await room.readDocument(grant!, { scope: "document" })).toBe("revoked");
  expect(fetch).toHaveBeenCalledTimes(1);
});
