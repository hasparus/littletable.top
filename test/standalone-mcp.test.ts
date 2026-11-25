import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

import type { BoardRoom as BoardRoomObject } from "../src/board-room";
import type { RoomDocumentCalls } from "../src/room-contract";

import { handle } from "../src/mcp/worker";
import { AssistantGrants } from "../src/standalone/assistant-grants";
import { Store } from "../src/standalone/store";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const issuer = "https://authkit.test";
const resource = "https://mcp.test/mcp";
const boardEnv = { ...standaloneEnv, MCP_RESOURCE: resource };
const { DB, BoardRoom } = env as unknown as {
  BoardRoom: DurableObjectNamespace;
  DB: D1Database;
};
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
    scopes_supported: ["openid", "offline_access"],
  });
  expect((await call(await mint("wrong-audience", "workos-client"))).status).toBe(401);
  expect((await call(await mint("agent", resource, "ai_agent"))).status).toBe(401);
  const token = await mint("assistant-one");
  const before = await call(token);
  expect(before.status).toBe(200);
  expect(await before.text()).toContain("manageAccess");
  const page = await owner.fetch("/assistants", {}, boardEnv);
  expect(await page.text()).toContain("Own &amp; &lt;board&gt;");
  expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
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

it.each([
  ["read", "grant update"],
  ["write", "grant update"],
  ["write", "link reset"],
  ["write", "board deletion"],
] as const)("discards a pending %s authorization after a %s", async (access, change) => {
  const grants = new AssistantGrants(DB);
  const owner = new Browser();
  const manager = new Browser();
  await owner.signIn("Ada");
  await manager.signIn("Bea");
  const board = await owner.createBoard();
  await manager.bootstrap(board.shareCode);
  const {
    account: { id: ownerId },
  } = await (await owner.fetch("/api/me")).json<{ account: { id: string } }>();
  const {
    account: { id: managerId },
  } = await (await manager.fetch("/api/me")).json<{ account: { id: string } }>();
  const store = new Store(DB);
  await store.setRole(board.id, managerId, "shaman");
  await grants.register(managerId, "assistant-one");
  await grants.set(managerId, "assistant-one", board.id, "write");
  const [grant] = await grants.grants(managerId, "assistant-one");
  expect(grant).toBeDefined();
  const room = BoardRoom.get(BoardRoom.idFromName(board.id));

  await runInDurableObject(room, async (object) => {
    const instance = object as unknown as BoardRoomObject;
    let finishCheck!: () => void;
    let resumeCheck!: () => void;
    const checked = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeCheck = resolve;
    });
    const admit = AssistantGrants.prototype.admits;
    const check = vi
      .spyOn(AssistantGrants.prototype, "admits")
      .mockImplementation(async function (this: AssistantGrants, pending) {
        const allowed = await admit.call(this, pending);
        finishCheck();
        await resume;
        expect(allowed).toBe(true);
        return allowed;
      });
    try {
      const pending =
        access === "read"
          ? instance.readDocument(grant!, { scope: "document" })
          : instance.commitDocument(grant!, {
              absent: [],
              puts: [],
              removes: [],
              since: 0,
              unchanged: [],
            });
      await checked;
      switch (change) {
        case "grant update":
          await grants.set(managerId, "assistant-one", board.id, "off");
          instance.assistantGrantsChanged();
          break;
        case "link reset": {
          const reset = await store.resetLink(board.id, ownerId, "new-share-code");
          expect(reset).not.toBeNull();
          instance.moveLink(board.id, reset!.linkVersion);
          break;
        }
        case "board deletion":
          expect(await store.delete(board.id, ownerId)).toBe(true);
          await instance.destroy(board.id);
          break;
      }
      resumeCheck();
      expect(await pending).toBe("revoked");
    } finally {
      resumeCheck();
      check.mockRestore();
    }
  });
});

it("keeps a manager's assistant grants off after demotion and promotion", async () => {
  const owner = new Browser();
  const manager = new Browser();
  const grants = new AssistantGrants(DB);
  await owner.signIn("Ada");
  await manager.signIn("Bea");
  const board = await owner.createBoard();
  await manager.bootstrap(board.shareCode);
  const { account } = await (await manager.fetch("/api/me")).json<{ account: { id: string } }>();
  const role = `/api/boards/${board.id}/people/${account.id}/role`;
  expect((await owner.post(role, { role: "shaman" })).status).toBe(200);
  await grants.register(account.id, "assistant-one");
  expect(await grants.set(account.id, "assistant-one", board.id, "write")).toBe(true);
  expect(await grants.grants(account.id, "assistant-one")).toHaveLength(1);

  expect((await owner.post(role, { role: "write" })).status).toBe(200);
  expect((await owner.post(role, { role: "shaman" })).status).toBe(200);
  expect(await grants.grants(account.id, "assistant-one")).toEqual([]);
});
