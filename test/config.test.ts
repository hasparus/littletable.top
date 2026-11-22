import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { ConfigEnv } from "../src/config";

import { type Env, handle } from "../src/index";
import { call, pass } from "./support";

const hostedEnv = env as unknown as Env;

const withEnv = (overrides: Partial<Record<keyof ConfigEnv, string | undefined>>) =>
  handle(new Request("https://board.test/b/AbC123xyz789"), { ...hostedEnv, ...overrides });

describe("a configuration", () => {
  it.each([
    ["no mode", { TABLETOP_MODE: undefined }],
    ["an unknown mode", { TABLETOP_MODE: "both" }],
    ["hosted mode without the issuer's key", { ISSUER_PUBLIC_KEY: "" }],
    ["hosted mode without a host", { HOST_ORIGIN: undefined }],
    ["a host origin with a path", { HOST_ORIGIN: "https://host.test/app" }],
    ["a key that is not a key", { ISSUER_PUBLIC_KEY: "not a key" }],
    ["hosted mode with a signing key of its own", { SIGNING_KEY: "anything" }],
    ["the standalone issuer on a hosted Worker", { ISSUER: "tabletop" }],
    ["the standalone audience on a hosted Worker", { PASS_AUDIENCE: "tabletop-standalone" }],
    ["one audience for passes and deletion", { DELETION_AUDIENCE: "board" }],
    ["aliases with no primary host", { ALIAS_HOSTS: "vtt.example.org" }],
  ])("with %s serves nothing", async (_label, overrides) => {
    const response = await withEnv(overrides);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("This tabletop is not configured");
  });

  it("serves the board once complete", async () => {
    expect((await withEnv({})).status).toBe(200);
  });

  it("names the issuer it trusts: a pass from another issuer on the same key is refused", async () => {
    const response = await handle(
      new Request("https://board.test/rooms/b1/rolls", {
        headers: { Authorization: `Bearer ${await pass()}` },
      }),
      { ...hostedEnv, ISSUER: "someone-else" },
    );

    expect(response.status).toBe(403);
    expect((await call("/rooms/b1/rolls", await pass())).status).toBe(200);
  });
});
