import type { Rooms } from "./server";

import { publicKeyFrom } from "../pass";
import { verifyMcpToken } from "./grant";
import { isMcpPath, type McpSettings, SCOPES, serveMcp } from "./route";
import { standaloneMcp } from "./standalone";

// The MCP Worker: assistants' door to the boards. It holds everything
// heavy (the MCP SDK, the ops engine, the text measurer and its fonts) so
// that the board Worker, which every player's request loads, holds none of
// it. It reaches a board through a binding to the board Worker's BoardRoom
// class and that class's document calls (src/room-document.ts).

export type McpEnv = {
  BOARD_DATA_SCOPE?: string;
  BoardRoom: Rooms;
  DB?: D1Database;
  MCP_BOARD_ORIGIN?: string;
  MCP_RESOURCE?: string;
  // The host's issuer name and public key (SPKI PEM), as the board Worker has them.
  ISSUER?: string;
  ISSUER_PUBLIC_KEY?: string;
  // The `aud` of MCP access tokens, and the host's authorization server.
  MCP_AUDIENCE?: string;
  MCP_AUTHORIZATION_SERVER?: string;
};

const DEFAULT_AUDIENCE = "tabletop-mcp";

function misconfigured(problem: string): Response {
  console.error(JSON.stringify({ event: "mcp.misconfigured", problem }));
  return new Response("This MCP server is not configured", { status: 500 });
}

let standalone:
  | {
      db: D1Database;
      deployment: string;
      issuer: string;
      manageUrl?: string;
      resource: string;
      settings: McpSettings;
    }
  | undefined;

export async function handle(request: Request, env: McpEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isMcpPath(url.pathname)) return new Response("Not found", { status: 404 });
  if (env.MCP_RESOURCE !== undefined || env.DB !== undefined) {
    const { DB: db, MCP_AUTHORIZATION_SERVER: issuer, MCP_RESOURCE: resource } = env;
    if (!db || !issuer || !resource)
      return misconfigured("standalone requires DB, MCP_AUTHORIZATION_SERVER and MCP_RESOURCE");
    const deployment = env.BOARD_DATA_SCOPE ?? "";
    let manageUrl;
    try {
      const endpoint = new URL(resource);
      if (
        resource !== `${endpoint.origin}/mcp` ||
        !resource.startsWith("https://") ||
        new URL(issuer).origin !== issuer ||
        !issuer.startsWith("https://")
      ) {
        return misconfigured("invalid standalone issuer origin or MCP resource URL");
      }
      if (url.origin !== endpoint.origin) return new Response("Not found", { status: 404 });
      if (env.MCP_BOARD_ORIGIN) manageUrl = new URL("/assistants", env.MCP_BOARD_ORIGIN).href;
    } catch {
      return misconfigured("invalid standalone URL configuration");
    }
    if (
      !standalone ||
      standalone.db !== db ||
      standalone.deployment !== deployment ||
      standalone.issuer !== issuer ||
      standalone.resource !== resource ||
      standalone.manageUrl !== manageUrl
    ) {
      standalone = {
        db,
        deployment,
        issuer,
        manageUrl,
        resource,
        settings: standaloneMcp(issuer, resource, db, manageUrl, deployment),
      };
    }
    return serveMcp(request, env.BoardRoom, standalone.settings);
  }
  const missing = (["ISSUER", "ISSUER_PUBLIC_KEY", "MCP_AUTHORIZATION_SERVER"] as const).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
  if (missing.length > 0) return misconfigured(`missing ${missing.join(", ")}`);
  let key: CryptoKey;
  try {
    key = await publicKeyFrom(env.ISSUER_PUBLIC_KEY!.replaceAll(String.raw`\n`, "\n"));
  } catch {
    return misconfigured("ISSUER_PUBLIC_KEY is not a public key in SPKI PEM form");
  }
  const verifier = { audience: env.MCP_AUDIENCE || DEFAULT_AUDIENCE, issuer: env.ISSUER!, key };
  return serveMcp(request, env.BoardRoom, {
    authenticate: (token) => verifyMcpToken(token, verifier).catch(() => null),
    authorizationServer: env.MCP_AUTHORIZATION_SERVER!,
    scopes: SCOPES,
  });
}

export default { fetch: handle } satisfies ExportedHandler<McpEnv>;
