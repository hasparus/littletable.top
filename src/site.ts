// The tabletop's pages and files: the names it answers to, the SPA shell at
// /b/<share code>, and the headers every page and file leaves with.

import type { Config, Hosts, StandaloneConfig } from "./config";

import { Store } from "./standalone/store";

// A request to an alias moves to the same path on the primary host, before
// anything else runs: no page, file, API or socket is served there.
export function aliasRedirect(request: Request, hosts: Hosts): Response | null {
  if (hosts.primary === null) return null;
  const url = new URL(request.url);
  if (!hosts.aliases.includes(url.hostname)) return null;
  url.hostname = hosts.primary;
  return Response.redirect(url.toString(), 308);
}

// NOTE: reading text off images (docs/internals.md, "Text in images") runs two
// engines compiled to WebAssembly in a worker of this origin, which needs
// 'wasm-unsafe-eval': it compiles WebAssembly and nothing else, so eval
// and string-built functions stay refused. Their workers are files of
// this origin too, never blob: URLs.
const SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'"];
const WORKER_SRC = ["'self'"];

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
    // A board's images come from its /rooms/<board>/files route on this
    // origin; tldraw previews an image from a blob: URL while it uploads.
    "img-src": ["'self'", "data:", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "script-src": SCRIPT_SRC,
    // NOTE: tldraw positions every shape with inline style attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
    "worker-src": WORKER_SRC,
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

const SHELL = /^\/b\/([A-Za-z0-9]{1,64})\/?$/u;
const WEBSITE_DESCRIPTION =
  "Draw maps, roll dice, and play tabletop games together on a shared whiteboard.";
// Vite names every built script, style and font after its content, and
// the text engines' files (WebAssembly, models, language data) carry the
// hash of theirs in their name or their folder's (vite.config.ts).
const HASHED = /^\/assets\//u;

async function shell(request: Request, assets: Fetcher, config: Config): Promise<Response> {
  const page = harden(
    await assets.fetch(new URL("/index.html", request.url), { method: request.method }),
    request,
    config,
  );
  page.headers.set("Cache-Control", "no-cache");
  page.headers.set("X-Robots-Tag", "noindex, nofollow");
  return page;
}

const htmlAttribute = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

// Social previews are read before any JavaScript runs. Use the public name
// a board already returns to people with its current share link.
function withOpenGraph(page: Response, url: URL, config: StandaloneConfig, boardTitle?: string) {
  if (!page.ok || page.body === null) return page;
  const title =
    boardTitle === undefined ? config.displayName : `${boardTitle} · ${config.displayName}`;
  const description =
    boardTitle === undefined
      ? WEBSITE_DESCRIPTION
      : `Join ${boardTitle} on ${config.displayName}. ${WEBSITE_DESCRIPTION}`;
  const graph = {
    description,
    image: new URL("/open-graph.png", url).href,
    "image:alt": "Little Table logo and tabletop dice",
    "image:height": "630",
    "image:type": "image/png",
    "image:width": "1200",
    site_name: config.displayName,
    title,
    type: "website",
    url: new URL(url.pathname.replace(/\/$/u, "") || "/", url).href,
  };
  return new HTMLRewriter()
    .on("template[data-board-preloads]", {
      element: (template) => {
        if (url.pathname === "/") template.removeAndKeepContent();
        else template.remove();
      },
    })
    .on("head", {
      element: (head) => {
        const tags = Object.entries(graph).map(
          ([name, value]) => `<meta property="og:${name}" content="${htmlAttribute(value)}">`,
        );
        head.append(
          `<meta name="description" content="${htmlAttribute(description)}">${tags.join("")}`,
          { html: true },
        );
      },
    })
    .on("head title", {
      element: (element) => {
        element.setInnerContent(title);
      },
    })
    .transform(page);
}

export async function serveSite(
  request: Request,
  assets: Fetcher,
  config: Config,
  database?: D1Database,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return harden(new Response("Method not allowed", { status: 405 }), request, config);
  }
  if (url.pathname === "/") {
    // Hosted, nothing lives at the root: a person who types the name goes
    // to the host. Standalone, the root opens the public board.
    if (config.mode === "hosted") {
      return harden(Response.redirect(config.homeUrl, 302), request, config);
    }
    return withOpenGraph(await shell(request, assets, config), url, config);
  }
  if (url.pathname === "/boards" && config.mode === "standalone")
    return shell(request, assets, config);
  const shareCode = SHELL.exec(url.pathname)?.[1];
  if (shareCode !== undefined) {
    const page = await shell(request, assets, config);
    if (config.mode === "hosted" || !page.ok || page.body === null) return page;
    const board = database === undefined ? null : await new Store(database).byShareCode(shareCode);
    return withOpenGraph(page, url, config, board?.title);
  }
  const file = harden(await assets.fetch(request), request, config);
  if (file.ok && HASHED.test(url.pathname)) {
    file.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return file;
}
