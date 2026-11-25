import { expect, it } from "vitest";

import type { Env } from "../src";

import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

it("reports the Durable Objects daily limit when opening a board or signing in", async () => {
  const Limiter = {
    get: () => ({
      take: async () => {
        throw new Error("Exceeded allowed duration in Durable Objects free tier.");
      },
    }),
    idFromName: () => ({}),
  } as unknown as Env["Limiter"];
  const workerEnv = { ...standaloneEnv, Limiter };
  const browser = new Browser();
  const bootstrap = await browser.fetch(
    "/api/public-board/bootstrap",
    {
      body: "{}",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      method: "POST",
    },
    workerEnv,
  );
  expect(bootstrap.status).toBe(503);
  expect(await bootstrap.json()).toEqual({ error: "daily-server-limit" });
  expect(Number(bootstrap.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(bootstrap.headers.get("Cache-Control")).toBe("no-store");

  const signIn = await browser.fetch("/auth/sign-in", {}, workerEnv);
  expect(signIn.status).toBe(503);
  expect(await signIn.text()).toContain("Little Table reached its daily server limit.");
});
