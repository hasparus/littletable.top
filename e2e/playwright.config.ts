import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { HOST, HOSTED, PORTS, STANDALONE, WORKOS } from "./ports";

// Each mode runs against the real Worker in workerd (wrangler dev) serving a
// client built for that mode: hosted with e2e/fake-host.ts, standalone with
// e2e/fake-workos.ts, on the ports of e2e/ports.ts.

const root = fileURLToPath(new URL("..", import.meta.url));
const isCI = process.env.CI !== undefined;

// NOTE: sandboxes that mandate an egress proxy export HTTPS_PROXY, which
// browsers do not pick up on their own; the tabletop itself makes no
// external request, so localhost bypasses it.
const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;

const env = { ...process.env, WRANGLER_SEND_METRICS: "false" } as Record<string, string>;

// A fresh store every run: board ids restart with the fake host, and the
// standalone database starts empty.
const tabletop = (mode: string, port: number, extra: string, setUp: string[] = []) =>
  [
    `rm -rf .wrangler/e2e-${mode} dist-e2e/${mode}`,
    `vite build --logLevel warn --outDir "$PWD/dist-e2e/${mode}"`,
    ...setUp,
    `exec wrangler dev --port ${port} --assets dist-e2e/${mode} --persist-to .wrangler/e2e-${mode} ${extra}`,
  ].join(" && ");

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: isCI,
  // NOTE: CI shards the suite by test, so one spec's tests can land on
  // different runners, each with its own servers.
  fullyParallel: isCI,
  outputDir: "test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Safari differs on image OCR and canvas encoders, so run both flows in WebKit.
    {
      grep: /found by others|a thumbnail shows a remote drawing/u,
      name: "webkit",
      testMatch: /(?:image-text|thumbnails)\.spec\.ts/u,
      use: { ...devices["Desktop Safari"] },
    },
  ],
  reporter: isCI ? [["github"], ["line"]] : [["line"]],
  retries: isCI ? 1 : 0,
  testDir: "./tests",
  timeout: 120_000,
  use: {
    // NOTE: most hosts cannot give Chromium its sandbox (containers, and
    // runners that deny unprivileged user namespaces).
    launchOptions: { chromiumSandbox: false },
    trace: "retain-on-failure",
    ...(proxyServer === undefined
      ? {}
      : { proxy: { bypass: "localhost,127.0.0.1", server: proxyServer } }),
  },
  webServer: [
    {
      command: "node e2e/fake-host.ts",
      cwd: root,
      env: { ...env, FAKE_HOST_PORT: String(PORTS.host), TABLETOP_ORIGIN: HOSTED },
      reuseExistingServer: !isCI,
      url: `${HOST}/`,
    },
    {
      command: tabletop("hosted", PORTS.hosted, `--var HOST_ORIGIN:${HOST}`),
      cwd: root,
      env: { ...env, TABLETOP_HOST_ORIGIN: HOST },
      reuseExistingServer: !isCI,
      timeout: 120_000,
      // A room without a pass answers 403, which counts as up.
      url: `${HOSTED}/rooms/e2e/rolls`,
    },
    {
      command: "node e2e/fake-workos.ts",
      cwd: root,
      env: { ...env, FAKE_WORKOS_PORT: String(PORTS.workos) },
      reuseExistingServer: !isCI,
      url: `${WORKOS}/user_management/authorize?client_id=client_fake`,
    },
    {
      command: tabletop(
        "standalone",
        PORTS.standalone,
        `--env-file e2e/standalone.env --var WORKOS_API_BASE:${WORKOS}`,
        ["wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-standalone"],
      ),
      cwd: root,
      env: { ...env, TABLETOP_MODE: "standalone" },
      reuseExistingServer: !isCI,
      timeout: 120_000,
      url: `${STANDALONE}/api/me`,
    },
  ],
  workers: 1,
});
