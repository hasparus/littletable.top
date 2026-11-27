import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function setAccess(
  browser: Browser,
  body: Record<string, string>,
  csrf: string,
  workerEnv: typeof standaloneEnv = boardEnv,
  origin = ORIGIN,
) {
  return browser.fetch(
    "/api/assistants",
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf },
      method: "POST",
    },
    workerEnv,
  );
}

it.each([issuer, `${issuer}/`])("advertises the canonical issuer for %s", async (configured) => {
  const metadata = await handle(
    new Request("https://mcp.test/.well-known/oauth-protected-resource/mcp"),
    { ...workerEnv, MCP_AUTHORIZATION_SERVER: configured },
  );
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({ resource, authorization_servers: [issuer] });
});

it.each([`${issuer}/oauth2`, `${issuer}//`, "http://authkit.test"])(
  "rejects %s as an AuthKit issuer origin",
  async (configured) => {
    const metadata = await handle(
      new Request("https://mcp.test/.well-known/oauth-protected-resource/mcp"),
      { ...workerEnv, MCP_AUTHORIZATION_SERVER: configured },
    );
    expect(metadata.status).toBe(500);
  },
);

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
  const update = (board: string, access: string, csrf = owner.csrf ?? "", browser = owner) =>
    setAccess(browser, { access, board, client: "assistant-one" }, csrf);
  expect((await update(own.id, "write", "invalid")).status).toBe(403);
  expect((await update(foreign.id, "write")).status).toBe(404);
  expect((await update(own.id, "write", other.csrf ?? "", other)).status).toBe(404);
  expect((await update(own.id, "read")).status).toBe(204);
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
  expect((await update(own.id, "off")).status).toBe(204);
  expect(await room.readDocument(grant!, { scope: "document" })).toBe("revoked");
  expect((await update(own.id, "write")).status).toBe(204);
  expect(await room.readDocument(grant!, { scope: "document" })).toBe("revoked");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps assistant grants within a board's preview deployment", async () => {
  const owner = new Browser();
  await owner.signIn("Ada");
  const { account } = await (await owner.fetch("/api/me")).json<{ account: { id: string } }>();
  const client = "preview-assistant";
  const grantsA = new AssistantGrants(DB, "pr-42");
  const grantsB = new AssistantGrants(DB, "pr-43");
  await grantsA.register(account.id, client);

  const addBoard = async (id: string, deployment: string, title: string) => {
    const result = await new Store(DB, deployment).createBoard({
      createdAt: Math.floor(Date.now() / 1000),
      firstPageName: null,
      id,
      ownerId: account.id,
      shareCode: `link-${id}`,
      title,
    });
    expect(result.board).toBeDefined();
    return result.board!;
  };
  const boardA = await addBoard("scopedBoardA", "pr-42", "First preview");
  const boardB = await addBoard("scopedBoardB", "pr-43", "Second preview");
  const production = await owner.createBoard("Production board");
  const previewEnv = { ...boardEnv, BOARD_DATA_SCOPE: "pr-42" };
  const html = await (await owner.fetch("/assistants", {}, previewEnv)).text();
  expect(html).toContain(boardA.title);
  expect(html).not.toContain(boardB.title);
  expect(html).not.toContain(production.title);

  const update = (board: string, access: "off" | "write") =>
    setAccess(owner, { access, board, client }, owner.csrf ?? "", previewEnv);
  expect((await update(boardB.id, "write")).status).toBe(404);
  expect((await update(production.id, "off")).status).toBe(404);
  expect((await update(boardA.id, "write")).status).toBe(204);
  expect(await grantsB.set(account.id, client, boardB.id, "read")).toBe(true);

  const fromA = await grantsA.grants(account.id, client);
  expect(fromA).toMatchObject([{ board: boardA.id, access: "write" }]);
  expect(await grantsB.grants(account.id, client)).toMatchObject([
    { board: boardB.id, access: "read" },
  ]);
  expect(await grantsA.admittedBoard(fromA[0]!)).not.toBeNull();
  expect(await grantsB.admittedBoard(fromA[0]!)).toBeNull();
  const otherRoom = BoardRoom.get(BoardRoom.idFromName(boardA.id)) as unknown as RoomDocumentCalls;
  expect(await otherRoom.readDocument(fromA[0]!, { scope: "document" })).toBe("revoked");
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
  await store.setRole(board.id, managerId, "manager");
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
    const admit = AssistantGrants.prototype.admittedBoard;
    const check = vi
      .spyOn(AssistantGrants.prototype, "admittedBoard")
      .mockImplementation(async function (this: AssistantGrants, pending) {
        const allowed = await admit.call(this, pending);
        finishCheck();
        await resume;
        expect(allowed).not.toBeNull();
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
          expect(await store.beginDeletion(board.id, ownerId)).toBe(true);
          await store.removeBoardForDeletion(board.id, ownerId);
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
  expect((await owner.post(role, { role: "manager" })).status).toBe(200);
  await grants.register(account.id, "assistant-one");
  expect(await grants.set(account.id, "assistant-one", board.id, "write")).toBe(true);
  expect(await grants.grants(account.id, "assistant-one")).toHaveLength(1);

  expect((await owner.post(role, { role: "write" })).status).toBe(200);
  expect((await owner.post(role, { role: "manager" })).status).toBe(200);
  expect(await grants.grants(account.id, "assistant-one")).toEqual([]);
});

describe("the assistants page", () => {
  const accountOf = async (browser: Browser) =>
    (await (await browser.fetch("/api/me")).json<{ account: { id: string } }>()).account.id;

  it("sends a signed-out visitor to sign in and back", async () => {
    const visitor = new Browser();
    for (const method of ["GET", "HEAD"]) {
      const page = await visitor.fetch("/assistants", { method }, boardEnv);
      expect(page.status).toBe(302);
      expect(page.headers.get("Location")).toBe(`${ORIGIN}/auth/sign-in?return=/assistants`);
    }
    expect((await visitor.fetch("/api/assistants", {}, boardEnv)).status).toBe(401);
  });

  it("answers a signed-in HEAD with the page's headers", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    const head = await owner.fetch("/assistants", { method: "HEAD" }, boardEnv);
    expect(head.status).toBe(200);
    expect(head.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("asks a signed-in person with no clients to connect one", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    await owner.createBoard("Unshared map");
    const html = await (await owner.fetch("/assistants?lang=en", {}, boardEnv)).text();
    expect(html).toContain("Connect a client to");
    expect(html).not.toContain("Unshared map");
  });

  it("renders each client's boards and the access it holds, in the visitor's language", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    const board = await owner.createBoard("Ada's <map>");
    const account = await accountOf(owner);
    const grants = new AssistantGrants(DB);
    await grants.register(account, "assistant-one");
    await grants.register(account, "assistant-two");
    await grants.set(account, "assistant-one", board.id, "write");

    const response = await owner.fetch("/assistants?lang=pl", {}, boardEnv);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain("<title>Asystenci · ");
    expect(html).toContain("Klient 2");
    expect(html).toContain("&lt;map&gt;");
    expect(html).not.toContain("<map>");
    const page = await (await owner.fetch("/api/assistants", {}, boardEnv)).json();
    expect(page).toMatchObject({
      clients: [
        { boards: [{ access: "write", id: board.id, role: "owner" }], id: "assistant-one" },
        { boards: [{ access: "off", id: board.id, role: "owner" }], id: "assistant-two" },
      ],
    });
  });

  it("saves a level only with the session's token, from this origin", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    const board = await owner.createBoard();
    await new AssistantGrants(DB).register(await accountOf(owner), "assistant-one");
    const body = { access: "read", board: board.id, client: "assistant-one" };
    const csrf = owner.csrf ?? "";

    expect((await setAccess(owner, body, "")).status).toBe(403);
    expect((await setAccess(owner, body, csrf, boardEnv, "https://elsewhere.test")).status).toBe(
      403,
    );
    expect((await setAccess(owner, { ...body, access: "admin" }, csrf)).status).toBe(400);
    expect((await setAccess(owner, { ...body, client: "assistant-two" }, csrf)).status).toBe(404);
    expect((await setAccess(owner, body, csrf, standaloneEnv)).status).toBe(404);
    expect((await setAccess(owner, body, csrf)).status).toBe(204);
    const page = await (await owner.fetch("/api/assistants", {}, boardEnv)).json();
    expect(page).toMatchObject({ clients: [{ boards: [{ access: "read" }] }] });
  });
});
