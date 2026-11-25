import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { fakeWorkOs } from "./e2e/fake-workos";

// The committed dev pair, which a local host signs passes with.
const devSigningKey = readFileSync(new URL("dev/dev-signing-key.pem", import.meta.url), "utf8");

// Standalone mode's own key in the tests: a different pair, so a pass from
// one mode can be tried against the other.
const standaloneKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

const issuerPublicKey = createPublicKey(devSigningKey)
  .export({ format: "pem", type: "spki" })
  .toString();

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// NOTE: the MCP Worker's tests run it beside the real board Worker, as in
// production: a second Worker in workerd, reached through the Durable Object
// binding. An auxiliary Worker must be built JavaScript, so it is bundled here.
const boardBundle = path(".wrangler/test-board");
// NOTE: wrangler wants the assets directory to exist, built or not.
mkdirSync(path("dist"), { recursive: true });
execFileSync(
  path("node_modules/.bin/wrangler"),
  ["deploy", "--dry-run", "--outdir", boardBundle, "-c", path("wrangler.json")],
  { cwd: path("."), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" },
);

const boardWasm = readdirSync(boardBundle)
  .filter((file) => file.endsWith(".wasm"))
  .map((file) => ({ path: `${boardBundle}/${file}`, type: "CompiledWasm" as const }));

const board = cloudflareTest({
  miniflare: {
    // A stand-in for the built client, so the suite runs without a build.
    assets: { binding: "ASSETS", directory: path("test/assets") },
    bindings: {
      ISSUER_PUBLIC_KEY: issuerPublicKey,
      STANDALONE_SIGNING_KEY: standaloneKey,
      TEST_MIGRATIONS: await readD1Migrations(path("migrations")),
      TEST_SIGNING_KEY: devSigningKey,
    },
    // Every request the Worker sends out meets a fake WorkOS.
    outboundService: (request) => fakeWorkOs(request as unknown as Request) as never,
  },
  wrangler: { configPath: "./wrangler.json" },
});

const mcp = cloudflareTest({
  miniflare: {
    bindings: { ISSUER_PUBLIC_KEY: issuerPublicKey, TEST_SIGNING_KEY: devSigningKey },
    // The tests open a board's sync socket as a browser would.
    serviceBindings: { BOARD: "tabletop" },
    workers: [
      {
        bindings: {
          HOST_ORIGIN: "http://localhost:8000",
          ISSUER: "dev-host",
          ISSUER_PUBLIC_KEY: issuerPublicKey,
          TABLETOP_MODE: "hosted",
        },
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          BoardRoom: { className: "BoardRoom", useSQLite: true },
          Limiter: { className: "Limiter", useSQLite: true },
        },
        modules: [{ path: `${boardBundle}/index.js`, type: "ESModule" }, ...boardWasm],
        name: "tabletop",
        r2Buckets: ["Files"],
      },
    ],
  },
  wrangler: { configPath: "./wrangler.mcp.json" },
});

// e2e/ holds Playwright's specs, which run in Node, not workerd.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [board],
        test: {
          exclude: ["test/mcp/**"],
          include: ["test/**/*.test.ts"],
          name: "board",
          setupFiles: ["test/setup.ts"],
        },
      },
      { plugins: [mcp], test: { include: ["test/mcp/**/*.test.ts"], name: "mcp" } },
    ],
  },
});
