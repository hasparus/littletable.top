import type { TLRecord } from "@tldraw/tlschema";

import { createTLSchema } from "@tldraw/tlschema";
import { env, exports } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";

import type { BoardGrant, RoomDocumentCalls } from "../../src/room-contract";

// The MCP Worker under test, with the real board Worker beside it
// (vitest.config.ts): `BoardRoom` is the cross-Worker binding production
// uses, `BOARD` a test-only way to open a board's sync socket.

const testEnv = env as unknown as {
  BOARD: Fetcher;
  BoardRoom: DurableObjectNamespace;
  TEST_SIGNING_KEY: string;
};

export const now = () => Math.floor(Date.now() / 1_000);

const sign = async (claims: Record<string, unknown>, audience: string, sub: string) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setAudience(audience)
    .setIssuer("dev-host")
    .setSubject(sub)
    .setIssuedAt(now())
    .setExpirationTime(now() + 300)
    .sign(await importPKCS8(testEnv.TEST_SIGNING_KEY, "RS256"));

type Granted = { access: "read" | "write"; board: string; grant?: number; title?: string };

export const token = (boards: Granted[], { audience = "tabletop-mcp" } = {}) =>
  sign(
    {
      boards: boards.map((board) => ({ grant: 0, role: "shaman", ...board })),
      client_id: "client-1",
    },
    audience,
    "u:1",
  );

export const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;

export const roomOf = (board: string) =>
  testEnv.BoardRoom.get(testEnv.BoardRoom.idFromName(board)) as unknown as RoomDocumentCalls;

let boards = 0;

export function freshBoard() {
  const id = `ops-${++boards}-${crypto.randomUUID().slice(0, 8)}`;
  const grant: BoardGrant = { access: "write", board: id, grant: 0, role: "shaman", title: null };
  const room = roomOf(id);
  const read = async () => {
    const snapshot = await room.readDocument(grant, { scope: "document" });
    if (snapshot === "revoked") throw new Error("revoked");
    return snapshot;
  };
  return {
    grant,
    id,
    read,
    records: async (): Promise<TLRecord[]> => (await read()).records,
    room,
  };
}

type SyncMessage = { data?: unknown; type: string };

export async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

// A connected browser, as far as the room can tell: enough of the tldraw
// sync protocol to be a session, collecting what the room sends.
export async function seat(board: string) {
  const pass = await sign({ board, link: 0, name: "Ania", owner: false }, "board", "u:1");
  const response = await testEnv.BOARD.fetch(
    `https://board.test/rooms/${board}/connect?sessionId=${crypto.randomUUID()}&pass=${pass}`,
    { headers: { Upgrade: "websocket" } },
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error(`refused: ${response.status}`);
  const received: SyncMessage[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    received.push(...(Array.isArray(message) ? message : [message]));
  });
  socket.accept();
  socket.send(
    JSON.stringify({
      connectRequestId: crypto.randomUUID(),
      lastServerClock: 0,
      protocolVersion: 8,
      schema: createTLSchema().serialize(),
      type: "connect",
    }),
  );
  await until(() => received.some((message) => message.type === "connect"));
  return { received };
}
