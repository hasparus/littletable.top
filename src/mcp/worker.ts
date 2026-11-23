import { publicKeyFrom } from "../pass";
import { isMcpPath, serveMcp } from "./route";
import { type Rooms } from "./server";

// The MCP Worker: assistants' door to the boards. It holds everything
// heavy (the MCP SDK, the ops engine, the text measurer and its fonts) so
// that the board Worker, which every player's request loads, holds none of
// it. It reaches a board through a binding to the board Worker's BoardRoom
// class and that class's document calls (src/room-document.ts).

export type McpEnv = {
  BoardRoom: Rooms;
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

export async function handle(request: Request, env: McpEnv): Promise<Response> {
  const missing = (["ISSUER", "ISSUER_PUBLIC_KEY", "MCP_AUTHORIZATION_SERVER"] as const).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
  if (missing.length > 0) return misconfigured(`missing ${missing.join(", ")}`);
  if (!isMcpPath(new URL(request.url).pathname)) return new Response("Not found", { status: 404 });
  let key: CryptoKey;
  try {
    key = await publicKeyFrom(env.ISSUER_PUBLIC_KEY!.replaceAll(String.raw`\n`, "\n"));
  } catch {
    return misconfigured("ISSUER_PUBLIC_KEY is not a public key in SPKI PEM form");
  }
  return serveMcp(request, env.BoardRoom, {
    authorizationServer: env.MCP_AUTHORIZATION_SERVER!,
    verifier: {
      audience:
        env.MCP_AUDIENCE === undefined || env.MCP_AUDIENCE === ""
          ? DEFAULT_AUDIENCE
          : env.MCP_AUDIENCE,
      issuer: env.ISSUER!,
      key,
    },
  });
}

export default { fetch: handle } satisfies ExportedHandler<McpEnv>;
