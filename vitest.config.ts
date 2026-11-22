import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The committed dev pair, which signs passes on laptops and in the tests.
const devSigningKey = readFileSync(new URL("dev/dev-signing-key.pem", import.meta.url), "utf8");

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        // A stand-in for the built client, so the suite runs without a build.
        assets: {
          binding: "ASSETS",
          directory: fileURLToPath(new URL("test/assets", import.meta.url)),
        },
        bindings: {
          ISSUER_PUBLIC_KEY: createPublicKey(devSigningKey)
            .export({ format: "pem", type: "spki" })
            .toString(),
          TEST_SIGNING_KEY: devSigningKey,
        },
      },
      wrangler: { configPath: "./wrangler.json" },
    }),
  ],
  // e2e/ holds Playwright's specs, which run in Node, not workerd.
  test: { include: ["test/**/*.test.ts"] },
});
