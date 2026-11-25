// Local development and the end-to-end tests only: one address for both
// Workers. In production the MCP Worker has a hostname of its own; on a
// laptop `wrangler dev` gives one port to its first Worker, and separate
// `wrangler dev` processes cannot call each other's Durable Objects. This
// Worker takes the port and hands each request to the Worker it is for.

type Env = { BOARD: Fetcher; MCP: Fetcher };

const forMcp = (pathname: string) =>
  pathname === "/mcp" || pathname.startsWith("/.well-known/oauth-protected-resource");

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return (forMcp(new URL(request.url).pathname) ? env.MCP : env.BOARD).fetch(request);
  },
} satisfies ExportedHandler<Env>;
