import type { Config, Hosts, StandaloneConfig } from "./config";
import type { PreviewBindings } from "./share-preview";
import type { Standalone } from "./standalone/routes";
import type { Board } from "./standalone/store";

import { renderBoards } from "./render-boards";
import { composeBoardPreview } from "./share-preview";
import { Store } from "./standalone/store";

/** Redirects aliases to the same path on the primary host before routing. */
export function aliasRedirect(request: Request, hosts: Hosts): Response | null {
  if (hosts.primary === null) return null;
  const url = new URL(request.url);
  if (!hosts.aliases.includes(url.hostname)) return null;
  url.hostname = hosts.primary;
  return Response.redirect(url.toString(), 308);
}

// WARNING: The OCR workers need `wasm-unsafe-eval`, which allows WebAssembly without allowing JavaScript eval.
const SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'"];
const WORKER_SRC = ["'self'"];

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
    // WARNING: Blocking blob: images breaks tldraw's preview while the upload is in flight.
    "img-src": ["'self'", "data:", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "script-src": SCRIPT_SRC,
    // WARNING: Blocking inline style attributes breaks positioning of tldraw shapes.
    "style-src": ["'self'", "'unsafe-inline'"],
    "worker-src": WORKER_SRC,
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

// WARNING: Apply the policy to static files too so direct requests for index.html cannot bypass it.
export function harden(response: Response, request: Request, config: Config): Response {
  const hardened = new Response(response.body, response);
  const { headers } = hardened;
  headers.set("Content-Security-Policy", contentSecurityPolicy(request, config));
  headers.set("X-Content-Type-Options", "nosniff");
  // WARNING: Sending referrers could leak the share code in the board URL.
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
const BOARD_PREVIEW = /^\/b\/([A-Za-z0-9]{1,64})\/preview\.png$/u;
const WEBSITE_DESCRIPTION =
  "Draw maps, roll dice, and play tabletop games together on a shared whiteboard.";
// WARNING: Only use immutable caching for paths that carry content hashes in their file or folder name.
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

// WARNING: Link preview crawlers need metadata in the HTML before client JavaScript runs.
function withOpenGraph(page: Response, url: URL, config: StandaloneConfig, board?: Board) {
  const boardTitle = board?.title;
  const illustrated = board?.hasThumbnail === true;
  if (!page.ok || page.body === null) return page;
  const title =
    boardTitle === undefined ? config.displayName : `${boardTitle} · ${config.displayName}`;
  const description =
    boardTitle === undefined
      ? WEBSITE_DESCRIPTION
      : `Join ${boardTitle} on ${config.displayName}. ${WEBSITE_DESCRIPTION}`;
  const graph = {
    description,
    image: new URL(illustrated ? `/b/${board.shareCode}/preview.png` : "/open-graph.png", url).href,
    "image:alt": illustrated
      ? `Little Table board: ${board.title}`
      : "Little Table logo and tabletop dice",
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

export async function serveBoards(
  request: Request,
  assets: Fetcher,
  config: StandaloneConfig,
  own: Standalone,
) {
  const page = await shell(request, assets, config);
  page.headers.set("Cache-Control", "private, no-store");
  if (!page.ok || page.body === null || request.method === "HEAD") return page;
  const data = await own.boardPage(request);
  const url = new URL(request.url);
  const requested = [
    url.searchParams.get("lang"),
    ...(request.headers.get("Accept-Language") ?? "")
      .split(",")
      .map((tag) => tag.split(";")[0]?.trim().split("-")[0]),
  ];
  let locale = requested.find((tag) => tag === "en" || tag === "pl");
  return new HTMLRewriter()
    .on("html", {
      element(html) {
        locale ??= html.getAttribute("lang") === "pl" ? "pl" : "en";
        html.setAttribute("lang", locale);
      },
    })
    .on("[data-board-root]", {
      element(root) {
        const state = {
          failed: url.searchParams.get("sign-in") === "failed",
          initialPage: data,
          locale: locale ?? "en",
          name: config.displayName,
        } as const;
        root.setAttribute("class", "fixed inset-0 overflow-y-auto bg-background");
        root.setInnerContent(renderBoards(state), { html: true });
        root.after(
          `<script type="application/json" id="boards-state">${JSON.stringify(state).replaceAll("<", String.raw`\u003c`)}</script>`,
          { html: true },
        );
      },
    })
    .transform(page);
}

type SiteBindings = PreviewBindings & { DB?: D1Database };

export async function serveSite(
  request: Request,
  env: SiteBindings,
  config: Config,
): Promise<Response> {
  const { ASSETS: assets, DB: database } = env;
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return harden(new Response("Method not allowed", { status: 405 }), request, config);
  }
  if (url.pathname === "/") {
    if (config.mode === "hosted") {
      return harden(Response.redirect(config.homeUrl, 302), request, config);
    }
    return withOpenGraph(await shell(request, assets, config), url, config);
  }
  const imageCode = BOARD_PREVIEW.exec(url.pathname)?.[1];
  if (imageCode !== undefined && config.mode === "standalone") {
    const board = database === undefined ? null : await new Store(database).byShareCode(imageCode);
    let preview: Response | null = null;
    if (board?.hasThumbnail === true) {
      preview =
        request.method === "HEAD"
          ? new Response(null, { headers: { "Content-Type": "image/png" } })
          : await composeBoardPreview(url, board, env);
    }
    const image =
      preview ?? (await assets.fetch(new URL("/open-graph.png", url), { method: request.method }));
    const response = harden(image, request, config);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }
  const shareCode = SHELL.exec(url.pathname)?.[1];
  if (shareCode !== undefined) {
    const page = await shell(request, assets, config);
    if (config.mode === "hosted" || !page.ok || page.body === null) return page;
    const board = database === undefined ? null : await new Store(database).byShareCode(shareCode);
    return withOpenGraph(page, url, config, board ?? undefined);
  }
  const file = harden(await assets.fetch(request), request, config);
  if (file.ok && HASHED.test(url.pathname)) {
    file.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return file;
}
