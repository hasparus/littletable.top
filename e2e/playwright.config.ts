import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Each mode runs against the real Worker in workerd (wrangler dev) serving a
// client built for that mode: hosted on :8788 with e2e/fake-host.ts on :8000,
// standalone on :8790 with e2e/fake-workos.ts on :8001.

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
  fullyParallel: false,
  outputDir: "test-results",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
      env,
      reuseExistingServer: !isCI,
      url: "http://localhost:8000/",
    },
    {
      command: tabletop("hosted", 8788, ""),
      cwd: root,
      env: { ...env, TABLETOP_HOST_ORIGIN: "http://localhost:8000" },
      reuseExistingServer: !isCI,
      timeout: 120_000,
      // A room without a pass answers 403, which counts as up.
      url: "http://localhost:8788/rooms/e2e/rolls",
    },
    {
      command: "node e2e/fake-workos.ts",
      cwd: root,
      env,
      reuseExistingServer: !isCI,
      url: "http://localhost:8001/user_management/authorize?client_id=client_fake",
    },
    {
      command: tabletop("standalone", 8790, "--env-file e2e/standalone.env", [
        "wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-standalone",
      ]),
      cwd: root,
      env: { ...env, TABLETOP_MODE: "standalone" },
      reuseExistingServer: !isCI,
      timeout: 120_000,
      url: "http://localhost:8790/api/me",
    },
  ],
  workers: 1,
});
