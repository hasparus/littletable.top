import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
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
          STANDALONE_SIGNING_KEY: standaloneKey,
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("migrations", import.meta.url)),
          ),
          TEST_SIGNING_KEY: devSigningKey,
        },
        outboundService: (request) => fakeWorkOs(request as unknown as Request) as never,
      },
      wrangler: { configPath: "./wrangler.json" },
    }),
  ],
  test: {
    // e2e/ holds Playwright's specs, which run in Node, not workerd.
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
