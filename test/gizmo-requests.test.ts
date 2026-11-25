import { describe, expect, it } from "vitest";

import type { GizmoRequest } from "../src/gizmo-packages";

import { call, linkReset, pass } from "./support";

const source = "https://github.com/test/gizmos/blob/" + "1".repeat(40) + "/deck/gizmo.json";

async function table(board: string) {
  const [owner, first, second] = await Promise.all([
    pass({ board, owner: true }),
    pass({ board, sub: "g:first", name: "Iga" }),
    pass({ board, sub: "u:second", name: "Kuba" }),
  ]);
  function api(token: string | null, body?: object) {
    return call(
      "/rooms/" + board + "/gizmo-requests",
      token,
      body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
    );
  }
  return {
    owner,
    first,
    second,
    api,
    async list(token: string) {
      return (await api(token)).json<GizmoRequest[]>();
    },
  };
}

describe("Gizmo install requests", () => {
  it("keeps one pending package with one signed name per requester, then approves it once", async () => {
    const board = "gizmo-request-share";
    const { owner, first, second, api, list } = await table(board);
    expect((await api(null, { url: source })).status).toBe(403);
    expect((await api(first, { url: "https://example.test/gizmo.json" })).status).toBe(400);
    const alias = source.replace("1".repeat(40), "main");
    const folder = alias.replace("/blob/", "/tree/").replace("/gizmo.json", "");
    const [a, b] = await Promise.all([api(first, { url: folder }), api(first, { url: alias })]);
    expect(a.status).toBe(200);
    const initial = await a.json<GizmoRequest>();
    expect(await b.json()).toEqual(initial);
    expect(initial).toEqual({
      id: expect.any(Number),
      status: "pending",
      url: alias,
      requesters: ["Iga"],
    });
    expect(await list(second)).toEqual([]);
    expect(await (await api(second, { url: alias })).json()).toEqual({
      ...initial,
      requesters: ["Kuba"],
    });
    expect(await list(owner)).toEqual([{ ...initial, requesters: ["Iga", "Kuba"] }]);
    expect(await list(first)).toEqual([initial]);
    const approve = { id: initial.id, action: "approve" };
    expect((await api(first, approve)).status).toBe(403);
    expect((await api(await pass({ board, sub: "g:first", owner: true }), approve)).status).toBe(
      403,
    );
    expect((await api(second, { id: initial.id, action: "decline" })).status).toBe(403);
    expect(await (await call("/rooms/" + board + "/gizmos", first)).json()).toEqual([]);
    const results = await Promise.all([api(owner, approve), api(owner, approve)]);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        ...initial,
        requesters: ["Iga", "Kuba"],
        status: "installed",
        installedUrl: source,
      });
    }
    expect(await list(first)).toEqual([{ ...initial, status: "installed", installedUrl: source }]);
    expect((await api(owner, { id: initial.id, action: "decline" })).status).toBe(409);
    expect(await (await call("/rooms/" + board + "/gizmos", second)).json()).toHaveLength(1);
  });

  it("keeps declines retryable while a new participant may reopen the package", async () => {
    const board = "gizmo-request-review";
    const { owner, first, second, api, list } = await table(board);
    const original = await (await api(first, { url: source })).json<GizmoRequest>();
    const decline = { id: original.id, action: "decline" };
    for (let retry = 0; retry < 2; retry++)
      expect(await (await api(owner, decline)).json()).toEqual({ ...original, status: "declined" });
    expect(await (await api(first, { url: source })).json()).toEqual({
      ...original,
      status: "declined",
    });
    const fresh = await (await api(second, { url: source })).json<GizmoRequest>();
    expect(fresh.status).toBe("pending");
    expect(fresh.id).not.toBe(original.id);
    expect((await api(owner, { id: original.id, action: "approve" })).status).toBe(409);
    expect((await api(owner, decline)).status).toBe(200);
    expect(await list(second)).toEqual([fresh]);
    const missing = await (
      await api(second, { url: source.replace("/deck/", "/missing/") })
    ).json<GizmoRequest>();
    expect((await api(owner, { id: missing.id, action: "approve" })).status).toBe(404);
    expect(await list(second)).toContainEqual(missing);
    expect(
      (
        await call("/rooms/" + board + "/gizmos", owner, {
          method: "POST",
          body: JSON.stringify({ url: source }),
        })
      ).status,
    ).toBe(200);
    expect(await list(second)).toContainEqual({
      ...fresh,
      status: "installed",
      installedUrl: source,
    });
    const reset = await linkReset({ board, link: 1 });
    await call("/rooms/" + board + "/link", reset, { method: "POST" });
    expect((await api(first, { url: source })).status).toBe(403);
    expect((await api(owner, decline)).status).toBe(403);
    expect((await api(second)).status).toBe(403);
  });
});
