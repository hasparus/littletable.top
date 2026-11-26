import { expect, it, vi } from "vitest";

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

it.each([
  ["/b/PrivateShareCode000001", "share"],
  ["/p/privateBoard/00000000-0000-4000-8000-123456789abc", "published-image"],
])("logs only the route label for quota errors on %s", async (path, route) => {
  const DB = {
    prepare: () => {
      throw new Error("Exceeded allowed duration in Durable Objects free tier.");
    },
  } as unknown as Env["DB"];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await new Browser().fetch(path, {}, { ...standaloneEnv, DB });
    expect(response.status).toBe(503);
    expect(error.mock.calls).toEqual([
      [JSON.stringify({ event: "tabletop.daily-server-limit", route })],
    ]);
  } finally {
    error.mockRestore();
  }
});
