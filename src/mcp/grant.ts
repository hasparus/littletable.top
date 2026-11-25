import { jwtVerify } from "jose";

import type { Verifier } from "../pass";
import type { BoardGrant } from "../room-contract";

// An MCP access token, which the host's authorization server signs after
// a board owner consents: which account the assistant acts for, and which
// boards it may read or edit. The board's Durable Object also checks the
// grant version, so a host revokes without the Worker asking it each call.

export type McpGrant = {
  account: string;
  boards: BoardGrant[];
  clientId: string | null;
  manageUrl?: string;
};

export const MAX_GRANTED_BOARDS = 100;
const BOARD_ID = /^[\w-]{1,64}$/u;

function boardGrant(value: unknown): BoardGrant {
  const { access, board, grant, role, title } = (value ?? {}) as Record<string, unknown>;
  if (
    typeof board !== "string" ||
    !BOARD_ID.test(board) ||
    (access !== "read" && access !== "write") ||
    // NOTE: an assistant acts only where its person is a manager of the board.
    (role !== "manager" && role !== "owner") ||
    !Number.isInteger(grant) ||
    (grant as number) < 0 ||
    (title !== undefined && (typeof title !== "string" || title.length > 200))
  ) {
    throw new Error("Invalid board grant");
  }
  return { access, board, grant: grant as number, role, title: title ?? null };
}

export async function verifyMcpToken(token: string, verifier: Verifier): Promise<McpGrant> {
  const { payload } = await jwtVerify(token, verifier.key, {
    algorithms: ["RS256"],
    audience: verifier.audience,
    issuer: verifier.issuer,
    requiredClaims: ["exp", "iat", "sub"],
  });
  const { boards, client_id: clientId, sub } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || !Array.isArray(boards) || boards.length > MAX_GRANTED_BOARDS) {
    throw new Error("Invalid MCP token");
  }
  return {
    account: sub,
    boards: boards.map(boardGrant),
    clientId: typeof clientId === "string" ? clientId : null,
  };
}
