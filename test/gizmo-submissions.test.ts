import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

import type { Env } from "../src/index";

import registry from "../gizmos/registry.json";
import { Browser, ORIGIN, standaloneEnv } from "./standalone-support";

const endpoint = "/api/gizmo-submissions";
const folder = "https://github.com/table-wizard/scenery/tree/main/gizmos/storm";
const sha = "0123456789abcdef0123456789abcdef01234567";
const pinned = "https://github.com/table-wizard/scenery/blob/" + sha + "/gizmos/storm/gizmo.json";
const dispatch =
  "https://api.github.com/repos/hasparus/littletable.top/actions/workflows/gizmo-submission.yml/dispatches";

afterEach(() => vi.restoreAllMocks());

it("pins the source before dispatch and sends its credential only to the registry workflow", async () => {
  const calls = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/table-wizard/scenery/commits/main") {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(sha);
    }
    expect(url).toBe(dispatch);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-dispatch");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ ref: "main", inputs: { source: pinned } });
    return new Response(null, { status: 204 });
  });
  const response = await new Browser().fetch(
    endpoint,
    {
      body: JSON.stringify({ url: folder }),
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    },
    { ...standaloneEnv, GIZMO_SUBMISSIONS_TOKEN: "test-dispatch" },
  );
  expect(calls).toHaveBeenCalledTimes(2);
  expect(response.status).toBe(202);
  const receipt = await response.json<{ status: string; url: string }>();
  expect(receipt.status).toBe("queued");
  expect(new URL(receipt.url).searchParams.get("q")).toBe(
    "is:pr head:gizmo-submission/" + createHash("sha256").update(pinned).digest("hex"),
  );
});

it("prepares the pinned GitHub issue without sending it or installing the package", async () => {
  const outgoing = vi.spyOn(globalThis, "fetch");
  const browser = new Browser();
  const response = await browser.post(endpoint, { url: pinned });
  expect(response.status).toBe(200);
  const result = await response.json<{ status: string; url: string }>();
  const issue = new URL(result.url);
  expect(result.status).toBe("confirm");
  expect(issue.origin + issue.pathname).toBe(
    "https://github.com/hasparus/littletable.top/issues/new",
  );
  expect([...issue.searchParams]).toEqual([
    ["title", "Submit Gizmo to marketplace"],
    ["body", pinned],
  ]);
  expect(await (await browser.post(endpoint, { url: registry[0]!.url })).json()).toEqual({
    status: "listed",
  });
  expect(outgoing).not.toHaveBeenCalled();
});

it("makes the public submission available to a hosted board", async () => {
  const response = await new Browser().fetch(
    endpoint,
    {
      body: JSON.stringify({ url: pinned }),
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    },
    env as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "confirm" });
});

it("requires a same-origin supported source and rate limits repeated submissions", async () => {
  const outgoing = vi.spyOn(globalThis, "fetch");
  const browser = new Browser();
  expect(
    (await browser.post(endpoint, { url: pinned }, { Origin: "https://other.test" })).status,
  ).toBe(403);
  expect((await browser.post(endpoint, { url: "https://example.test/gizmo.json" })).status).toBe(
    400,
  );
  expect((await browser.post(endpoint, { url: "x".repeat(5_000) })).status).toBe(413);
  for (let i = 0; i < 4; i++) expect((await browser.post(endpoint, { url: pinned })).ok).toBe(true);
  expect((await browser.post(endpoint, { url: pinned })).status).toBe(429);
  expect(outgoing).not.toHaveBeenCalled();
});
