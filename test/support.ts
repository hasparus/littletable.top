import { createTLSchema } from "@tldraw/tlschema";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";
import { expect } from "vitest";

import type { BoardRoom } from "../src/board-room";

// WARNING: Keep this version in sync with sync-core’s internal protocol. A mismatch fails every seat() with an incompatibility error.
export const TLSYNC_PROTOCOL_VERSION = 8;

const testEnv = env as unknown as { TEST_SIGNING_KEY: string };

// wrangler.json's issuer, which a local hosted Worker trusts.
const DEV_ISSUER = "dev-host";

export const now = () => Math.floor(Date.now() / 1_000);

type Claims = {
  audience?: string;
  avatar?: string;
  board?: string;
  issuedAt?: number;
  link?: number;
  name?: string;
  owner?: boolean;
  role?: string;
  sub?: string;
};

export async function pass({
  audience = "board",
  avatar,
  board = "b1",
  issuedAt = now(),
  link = 0,
  name = "Ania",
  owner = false,
  role,
  sub = "u:1",
}: Claims = {}) {
  return new SignJWT({
    board,
    link,
    name,
    owner,
    sub,
    ...(avatar === undefined ? {} : { avatar }),
    ...(role === undefined ? {} : { role }),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setAudience(audience)
    .setIssuer(DEV_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(await importPKCS8(testEnv.TEST_SIGNING_KEY, "RS256"));
}

const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;

export function deletion({
  audience = "board-deletion",
  board = "b1",
  issuedAt = now(),
}: { audience?: string; board?: string; issuedAt?: number } = {}) {
  return boardCommand({ board }, audience, issuedAt);
}

export function linkReset(claims: { board: string; link?: unknown }, issuedAt = now()) {
  return boardCommand(claims, "board-link-reset", issuedAt);
}

async function boardCommand(
  claims: { board: string; link?: unknown },
  audience: string,
  issuedAt: number,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setAudience(audience)
    .setIssuer(DEV_ISSUER)
    .setExpirationTime(issuedAt + 300)
    .sign(await importPKCS8(testEnv.TEST_SIGNING_KEY, "RS256"));
}

export function destroy(board: string, token: string | null) {
  return call(`/rooms/${board}/delete`, token, { method: "POST" });
}

export function call(path: string, token: string | null, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`https://board.test${path}`, {
      ...init,
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

export function roll(board: string, token: string, dice: unknown) {
  return call(`/rooms/${board}/roll`, token, { body: JSON.stringify({ dice }), method: "POST" });
}

export async function restartRoom(board: string) {
  const namespace = (env as unknown as { BoardRoom: DurableObjectNamespace<BoardRoom> }).BoardRoom;
  const room = namespace.get(namespace.idFromName(board));
  const reason = "restart board room for test";
  await expect(runInDurableObject(room, (_room, state) => state.abort(reason))).rejects.toThrow(
    reason,
  );
}

export async function open(
  board: string,
  token: string,
  sessionId: string = crypto.randomUUID(),
  storeId?: string,
) {
  const url = new URL(`https://board.test/rooms/${board}/connect`);
  url.search = new URLSearchParams({ pass: token, sessionId }).toString();
  if (storeId !== undefined) url.searchParams.set("storeId", storeId);
  const response = await worker.fetch(
    new Request(url, {
      headers: { Upgrade: "websocket" },
    }),
  );
  const socket = (response as unknown as { webSocket: WebSocket | null }).webSocket;
  const closure = new Promise<{ code: number; reason: string }>((resolve) =>
    socket?.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
  );
  socket?.accept();
  return { closure, response, socket };
}

type SyncMessage = { data?: unknown; type: string };

// Speaks just enough of the tldraw sync protocol to become a connected
// session, then collects what the room sends.
export async function seat(board: string, token: string, sessionId?: string, storeId?: string) {
  const { closure, response, socket } = await open(board, token, sessionId, storeId);
  if (socket === null) throw new Error(`refused: ${response.status}`);
  const received: SyncMessage[] = [];
  let closed = false;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    received.push(...(Array.isArray(message) ? message : [message]));
  });
  socket.addEventListener("close", () => (closed = true));
  socket.send(
    JSON.stringify({
      connectRequestId: crypto.randomUUID(),
      lastServerClock: 0,
      protocolVersion: TLSYNC_PROTOCOL_VERSION,
      schema: createTLSchema().serialize(),
      type: "connect",
    }),
  );
  await until(() => received.some((message) => message.type === "connect"));
  return {
    close: () => socket.close(1000),
    closure,
    isClosed: () => closed,
    received,
    send: (message: object) => socket.send(JSON.stringify(message)),
  };
}

export async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
