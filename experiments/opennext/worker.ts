// @ts-expect-error OpenNext generates this entry point at build time.
import next from "./.open-next/worker.js";

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_next/")) return next.fetch(request, env, ctx);
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      (url.pathname !== "/" && url.pathname !== "/boards") ||
      url.searchParams.get("renderer") !== "opennext"
    ) {
      return env.TABLETOP.fetch(request);
    }

    const nonce = crypto.randomUUID();
    const scheme = url.protocol === "https:" ? "wss:" : "ws:";
    const policy = [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `connect-src 'self' ${scheme}//${url.host}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    const headers = new Headers(request.headers);
    headers.set("Content-Security-Policy", policy);
    const rendered = await next.fetch(new Request(request, { headers }), env, ctx);
    const response = new Response(rendered.body, rendered);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Content-Security-Policy", policy);
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Little-Table-Renderer", "opennext");
    return response;
  },
};
