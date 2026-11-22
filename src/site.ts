// The tabletop's pages and files: the names it answers to, the SPA shell at
// /b/<share code>, and the headers every page and file leaves with.

import type { Config, Hosts } from "./config";

// A request to an alias moves to the same path on the primary host, before
// anything else runs: no page, file, API or socket is served there.
export function aliasRedirect(request: Request, hosts: Hosts): Response | null {
  if (hosts.primary === null) return null;
  const url = new URL(request.url);
  if (!hosts.aliases.includes(url.hostname)) return null;
  url.hostname = hosts.primary;
  return Response.redirect(url.toString(), 308);
}

// NOTE: the dice draw with three.js on a plain canvas today. Physics in
// WebAssembly would need "'wasm-unsafe-eval'" here, and nowhere else.
const SCRIPT_SRC = ["'self'"];

// The shell's Content-Security-Policy: its own scripts, fonts and tldraw's
// self-hosted assets, the rooms socket on this host, and in hosted mode the
// host's origin for the pass request.
export function contentSecurityPolicy(request: Request, config: Config): string {
  const { host, protocol } = new URL(request.url);
  const socket = `${protocol === "https:" ? "wss" : "ws"}://${host}`;
  const connect = ["'self'", socket];
  if (config.mode === "hosted") connect.push(config.hostOrigin);
  const directives: Record<string, string[]> = {
    "base-uri": ["'none'"],
    "connect-src": connect,
    "default-src": ["'none'"],
    "font-src": ["'self'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
    // Uploaded images will come from this Worker's own /assets route.
    "img-src": ["'self'", "data:", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "script-src": SCRIPT_SRC,
    // NOTE: tldraw positions every shape with inline style attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

// What every response of the app carries, page or file. The policy goes on
// files too, so that index.html fetched by its own name is no way around it.
export function harden(response: Response, request: Request, config: Config): Response {
  const hardened = new Response(response.body, response);
  const { headers } = hardened;
  headers.set("Content-Security-Policy", contentSecurityPolicy(request, config));
  headers.set("X-Content-Type-Options", "nosniff");
  // The address holds the board's share code, which opens the board.
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
  );
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return hardened;
}

const SHELL = /^\/b\/[A-Za-z0-9]{1,64}\/?$/u;
// Vite names every built script, style and font after its content.
const HASHED = /^\/assets\//u;

async function shell(request: Request, assets: Fetcher, config: Config): Promise<Response> {
  const page = harden(await assets.fetch(new URL("/index.html", request.url)), request, config);
  page.headers.set("Cache-Control", "no-cache");
  page.headers.set("X-Robots-Tag", "noindex, nofollow");
  return page;
}

export async function serveSite(
  request: Request,
  assets: Fetcher,
  config: Config,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return harden(new Response("Method not allowed", { status: 405 }), request, config);
  }
  if (url.pathname === "/") {
    // Hosted, nothing lives at the root: a person who types the name goes
    // to the host. Standalone, the root is the tabletop's own front page.
    if (config.mode === "hosted") {
      return harden(Response.redirect(config.homeUrl, 302), request, config);
    }
    return shell(request, assets, config);
  }
  if (SHELL.test(url.pathname)) return shell(request, assets, config);
  const file = harden(await assets.fetch(request), request, config);
  if (file.ok && HASHED.test(url.pathname)) {
    file.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return file;
}
