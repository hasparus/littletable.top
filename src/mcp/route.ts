import type { Verifier } from "../pass";

import { verifyMcpToken } from "./grant";
import { mcpHandler, type Rooms } from "./server";

// The MCP endpoint as an OAuth protected resource (RFC 9728): it names the
// host's authorization server, answers 401 with a pointer to that metadata
// until a client brings an access token, and verifies the token itself,
// with the issuer key the Worker already trusts for passes.

export const MCP_PATH = "/mcp";
const METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
]);

export const SCOPES = ["boards:read", "boards:write"];

export type McpSettings = { authorizationServer: string; verifier: Verifier };

const metadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

export function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || METADATA_PATHS.has(pathname);
}

function unauthorized(origin: string, error?: string): Response {
  const parts = [`resource_metadata="${metadataUrl(origin)}"`, `scope="${SCOPES.join(" ")}"`];
  if (error !== undefined) parts.push(`error="${error}"`);
  return new Response("Unauthorized", {
    headers: { "WWW-Authenticate": `Bearer ${parts.join(", ")}` },
    status: 401,
  });
}

export async function serveMcp(
  request: Request,
  rooms: Rooms,
  settings: McpSettings,
): Promise<Response> {
  const url = new URL(request.url);
  if (METADATA_PATHS.has(url.pathname)) {
    return Response.json(
      {
        authorization_servers: [settings.authorizationServer],
        bearer_methods_supported: ["header"],
        resource: `${url.origin}${MCP_PATH}`,
        resource_name: "Tabletop boards",
        scopes_supported: SCOPES,
      },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=3600" } },
    );
  }
  // NOTE: assistants call from their own servers; a page in a browser on
  // another origin has no business here, token or not.
  const from = request.headers.get("Origin");
  if (from !== null && from !== url.origin) return new Response("Forbidden", { status: 403 });
  const token = request.headers.get("Authorization")?.replace(/^Bearer /u, "");
  if (token === undefined) return unauthorized(url.origin);
  let grant;
  try {
    grant = await verifyMcpToken(token, settings.verifier);
  } catch {
    return unauthorized(url.origin, "invalid_token");
  }
  const handler = mcpHandler(grant, rooms, ({ board, outcome, tool }) =>
    log("mcp.call", { account: grant.account, board, client: grant.clientId, outcome, tool }),
  );
  return handler.fetch(request, {
    authInfo: { clientId: grant.clientId ?? grant.account, scopes: [], token },
  });
}
