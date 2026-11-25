import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Asks the real tldraw editor how it sizes the labels in
// e2e/measure/corpus.ts and writes the answers to
// test/mcp/fixtures/browser-text.<project>.json, which the Workers suite
// compares the server-side measurer with. Run it again after a tldraw or
// font update:
//
//   aube run e2e:measure
//
// "chromium" turns font hinting off, which lays text out with fractional
// advances as Chrome does on macOS, Windows and Android; "chromium-hinted"
// is Chrome's Linux default (whole-pixel advances).

const root = fileURLToPath(new URL("..", import.meta.url));
// NOTE: moves with the other e2e servers (e2e/ports.ts).
const port = Number(process.env.MEASURE_PORT ?? 8797 + Number(process.env.E2E_PORT_OFFSET ?? 0));
const sandbox = { chromiumSandbox: false };

export default defineConfig({
  outputDir: "test-results/measure",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { ...sandbox, args: ["--font-render-hinting=none"] },
      },
    },
    { name: "chromium-hinted", use: { ...devices["Desktop Chrome"], launchOptions: sandbox } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: [["line"]],
  testDir: "./measure",
  testMatch: "*.spec.ts",
  timeout: 300_000,
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: "vite --config e2e/measure/vite.config.ts --logLevel warn",
    cwd: root,
    reuseExistingServer: false,
    url: `http://localhost:${port}/`,
  },
  workers: 1,
});
