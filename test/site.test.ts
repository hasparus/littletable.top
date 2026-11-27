import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { type Env, handle } from "../src/index";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const worker = (exports as unknown as { default: { fetch: typeof fetch } }).default;
const testEnv = env as unknown as { PRIMARY_HOST?: string };

const get = (url: string, init: RequestInit = {}) =>
  worker.fetch(new Request(url, { redirect: "manual", ...init }));

function directives(response: Response): Map<string, string[]> {
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  return new Map(
    policy.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/u);
      return [name, sources];
    }),
  );
}

describe("the board shell", () => {
  it.each(["/b/AbC123xyz789", "/b/AbC123xyz789/"])("is served at %s", async (path) => {
    const response = await get(`https://board.test${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/u);
    expect(await response.text()).toContain("data-board-root");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("carries a policy that allows the board and nothing else", async () => {
    const policy = directives(await get("https://board.test/b/AbC123xyz789"));

    expect(Object.fromEntries(policy)).toEqual({
      "base-uri": ["'none'"],
      "connect-src": ["'self'", "wss://board.test", "http://localhost:8000"],
      "default-src": ["'none'"],
      "font-src": ["'self'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"],
      "img-src": ["'self'", "data:", "blob:"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "script-src": ["'self'", "'wasm-unsafe-eval'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "worker-src": ["'self'"],
    });
  });

  it("opens its socket in plain text where the page is plain text", async () => {
    const policy = directives(await get("http://localhost:8788/b/AbC123xyz789"));

    expect(policy.get("connect-src")).toContain("ws://localhost:8788");
  });

  it("leaves with the hardening headers", async () => {
    const { headers } = await get("https://board.test/b/AbC123xyz789");

    expect({
      coop: headers.get("Cross-Origin-Opener-Policy"),
      frame: headers.get("X-Frame-Options"),
      hsts: headers.get("Strict-Transport-Security"),
      permissions: headers.get("Permissions-Policy"),
      referrer: headers.get("Referrer-Policy"),
      sniff: headers.get("X-Content-Type-Options"),
    }).toEqual({
      coop: "same-origin",
      frame: "DENY",
      hsts: "max-age=31536000; includeSubDomains",
      permissions:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
      referrer: "no-referrer",
      sniff: "nosniff",
    });
  });

  it.each(["/b/", "/b/not-a-code!", "/b/AbC/extra", "/elsewhere"])(
    "is not served at %s",
    async (path) => {
      expect((await get(`https://board.test${path}`)).status).toBe(404);
    },
  );

  it("refuses anything but reading", async () => {
    const response = await get("https://board.test/b/AbC123xyz789", { method: "POST" });

    expect(response.status).toBe(405);
  });

  it("sends a person at the bare name to the host", async () => {
    const response = await get("https://board.test/");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://localhost:8000/");
  });

  it("sends them to the host's own page for it when one is configured", async () => {
    const response = await handle(new Request("https://board.test/", { redirect: "manual" }), {
      ...(env as unknown as Env),
      HOME_URL: "http://localhost:8000/boards/",
    });

    expect(response.headers.get("Location")).toBe("http://localhost:8000/boards/");
  });
});

describe("the built files", () => {
  it("are cached for good when their names carry a hash", async () => {
    const response = await get("https://board.test/assets/app-fixture.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  // What the text engines load: WebAssembly, which a browser compiles
  // while it arrives only with its own type; language data, gzipped, which
  // must arrive as the gzip file it is, not unpacked by the way; models.
  it.each([
    ["/assets/ocr/ort-fixture.wasm", "application/wasm"],
    ["/assets/ocr/tessdata-fixture/pol.traineddata.gz", "application/gzip"],
    ["/assets/ocr/detector-fixture.onnx", null],
  ])("serve the text engines' %s for good", async (path, type) => {
    const response = await get(`https://board.test${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    if (type !== null) expect(response.headers.get("Content-Type")).toBe(type);
    expect(directives(response).get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it("include the manifest, under the same policy", async () => {
    const response = await get("https://board.test/manifest.webmanifest");

    expect(response.status).toBe(200);
    expect(directives(response).get("default-src")).toEqual(["'none'"]);
  });

  it("put the policy on index.html fetched by its own name", async () => {
    const response = await get("https://board.test/index.html");

    expect(directives(response).get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });
});

describe("standalone board list HTML", () => {
  it("renders private links for their owner and sign-in for visitors", async () => {
    const owner = new Browser();
    await owner.signIn("List owner");
    const board = await owner.createBoard("A <private> table");
    const response = await owner.fetch("/boards");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain(`href="/b/${board.shareCode}"`);
    expect(html).toContain("A &lt;private&gt; table");
    expect(html).not.toContain("A <private> table");
    const guest = await (await new Browser().fetch("/boards")).text();
    expect(guest).toContain('href="/auth/sign-in?return=/boards"');
    expect(guest).not.toContain(board.shareCode);
  });
});

describe("standalone link previews", () => {
  const config = { ...standaloneEnv, DISPLAY_NAME: "Little Table" };

  it("describes the public board without running the client", async () => {
    const response = await new Browser().fetch("/?lang=en&utm_source=share", {}, config);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const html = await response.text();
    expect(html).toContain('<meta property="og:title" content="Little Table">');
    expect(html).toContain(
      '<meta property="og:description" content="Draw maps, roll dice, and play tabletop games together on a shared whiteboard.">',
    );
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/open-graph.png">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/">`);
  });

  it("uses the shared board's escaped title and the same image for a guest", async () => {
    const owner = new Browser();
    await owner.signIn("Preview test owner");
    const board = await owner.createBoard('Keep & "Guests" <Map>');
    const guest = new Browser();
    const share = await guest.fetch(`/b/${board.shareCode}/?lang=pl`, {}, config);
    const html = await share.text();
    const title = "Keep &amp; &quot;Guests&quot; &lt;Map&gt;";
    expect(html).toContain(`<meta property="og:title" content="${title} · Little Table">`);
    expect(html).toContain(
      `<meta property="og:description" content="Join ${title} on Little Table.`,
    );
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/open-graph.png">`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/b/${board.shareCode}">`);
    expect(html).not.toContain("<Map>");
    expect(html).not.toContain("Preview test owner");

    const accountLink = await guest.fetch(`/b/${board.id}`, {}, config);
    const unshared = await accountLink.text();
    expect(unshared).toContain('<meta property="og:title" content="Little Table">');
    expect(unshared).not.toContain(title);
  });
});

describe("PostHog browser configuration", () => {
  const production = { ...standaloneEnv, POSTHOG_WEB_PROJECT_TOKEN: "phc_test" };

  it("exposes the public token and allows PostHog on the homepage when configured", async () => {
    const response = await new Browser().fetch("/", {}, production);
    const policy = directives(response);
    expect(policy.get("connect-src")).toContain("https://us.i.posthog.com");
    expect(policy.get("script-src")).toContain("https://us-assets.i.posthog.com");
    expect(policy.get("worker-src")).toContain("blob:");
    expect(await response.text()).toContain(
      '<meta name="posthog-project-token" content="phc_test">',
    );
  });

  it.each(["/boards", "/b/AbC123xyz789"])("keeps PostHog off %s", async (path) => {
    const response = await new Browser().fetch(path, {}, production);
    expect(response.headers.get("Content-Security-Policy")).not.toContain("posthog.com");
    expect(await response.text()).not.toContain("posthog-project-token");
  });

  it("offers Support on signed-in boards without injecting the token", async () => {
    const owner = new Browser();
    await owner.signIn("Support tester");
    const board = await owner.createBoard("A private table");
    const list = await (await owner.fetch("/boards", {}, production)).text();
    expect(list).toContain('href="/docs/?support"');
    expect(list).toContain('rel="noreferrer"');
    const shell = await (await owner.fetch(`/b/${board.shareCode}`, {}, production)).text();
    expect(shell).toContain('<meta name="little-table-support">');
    expect(shell).not.toContain('name="posthog-project-token"');
  });

  it("keeps PostHog off unconfigured deployments", async () => {
    const response = await new Browser().fetch("/");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("posthog.com");
    expect(await response.text()).not.toContain("posthog-project-token");
  });
});

describe("the board's other names", () => {
  const withRoot = (rootDomain: string, url: string) =>
    handle(new Request(url, { redirect: "manual" }), {
      ...(env as unknown as Env),
      ALIAS_HOSTS: ["vtt", "tabletop", "table"].map((label) => `${label}.${rootDomain}`).join(","),
      PRIMARY_HOST: `board.${rootDomain}`,
    });

  it.each(["vtt", "tabletop", "table"])(
    "%s moves to the board's own host, path and query kept",
    async (label) => {
      const response = await withRoot(
        "example.org",
        `https://${label}.example.org/b/AbC123xyz789?lang=pl`,
      );

      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(
        "https://board.example.org/b/AbC123xyz789?lang=pl",
      );
    },
  );

  it("serves no API on an alias", async () => {
    const response = await withRoot("example.org", "https://vtt.example.org/rooms/b1/rolls");

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://board.example.org/rooms/b1/rolls");
  });

  it("does not move the board's own host", async () => {
    const response = await withRoot("example.org", "https://board.example.org/b/AbC123xyz789");

    expect(response.status).toBe(200);
  });

  it("serves an unknown host as it is, as on a workers.dev preview", async () => {
    const response = await withRoot(
      "example.org",
      "https://tabletop-pr-7.example.workers.dev/b/AbC123xyz789",
    );

    expect(response.status).toBe(200);
  });

  it("moves nothing without a primary host", async () => {
    expect(testEnv.PRIMARY_HOST).toBeUndefined();
    const response = await get("https://vtt.example.org/b/AbC123xyz789");

    expect(response.status).toBe(200);
  });
});
