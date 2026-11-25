import { describe, expect, it } from "vitest";

import {
  gizmoSource,
  isGizmoAssetUrl,
  normalizeManifest,
  type InstalledGizmo,
} from "../src/gizmo-packages";
import { call, linkReset, pass } from "./support";

const prefix = "https://github.com/test/gizmos/blob/" + "1".repeat(40) + "/";
const source = prefix + "deck/gizmo.json";
const install = (board: string, token: string | null, url = source) =>
  call("/rooms/" + board + "/gizmos", token, { method: "POST", body: JSON.stringify({ url }) });
const list = (board: string, token: string | null) => call("/rooms/" + board + "/gizmos", token);

describe("Gizmo packages", () => {
  it("installs immutable manifests once and serves only their declared raster files", async () => {
    const board = "gizmo-install";
    const owner = await pass({ board, owner: true });
    const guest = await pass({ board, sub: "g:visitor" });
    expect(await (await list(board, owner)).json()).toEqual([]);
    const [a, b] = await Promise.all([install(board, owner), install(board, owner)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const installed = await a.json<InstalledGizmo>();
    expect(await b.json()).toEqual(installed);
    expect(installed.url).toBe(source);
    expect(installed.manifest.kind).toBe("deck");
    expect(isGizmoAssetUrl(installed.manifest.preview)).toBe(true);
    expect(await (await list(board, guest)).json()).toEqual([installed]);
    const preview = await call(installed.manifest.preview, null);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/png");
    expect(preview.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(preview.headers.get("Cache-Control")).toContain("immutable");
    expect(
      (await call(installed.manifest.preview.replace("back.png", "undeclared.png"), null)).status,
    ).toBe(404);
    const uninstalled = await pass({ board: "gizmo-empty" });
    expect(await (await list("gizmo-empty", uninstalled)).json()).toEqual([]);
  });

  it("requires current owner access and a commit-pinned source", async () => {
    const board = "gizmo-access";
    const owner = await pass({ board, owner: true });
    expect((await list(board, null)).status).toBe(403);
    expect((await install(board, null)).status).toBe(403);
    expect((await install(board, await pass({ board }))).status).toBe(403);
    expect((await install(board, await pass({ board, owner: true, sub: "g:guest" }))).status).toBe(
      403,
    );
    expect((await install(board, owner, source.replace("1".repeat(40), "main"))).status).toBe(400);
    expect((await install(board, owner, prefix + "large/gizmo.json")).status).toBe(413);
    expect((await install(board, owner, prefix + "bad/gizmo.json")).status).toBe(422);
    expect((await install(board, owner, prefix + "redirect/gizmo.json")).status).toBe(502);
    expect(await (await list(board, owner)).json()).toEqual([]);
    const reset = await linkReset({ board, link: 1 });
    expect((await call("/rooms/" + board + "/link", reset, { method: "POST" })).status).toBe(204);
    expect((await install(board, owner)).status).toBe(403);
    expect((await list(board, owner)).status).toBe(403);
  });

  it("checks raster headers before serving upstream bytes", async () => {
    const board = "gizmo-pictures";
    const owner = await pass({ board, owner: true });
    const installed = await (
      await install(board, owner, prefix + "text/gizmo.json")
    ).json<InstalledGizmo>();
    expect((await call(installed.manifest.preview, null)).status).toBe(415);
  });

  it("accepts package-local asset paths and a fixed set of declarative fields", () => {
    const manifest = {
      version: 1,
      kind: "button",
      preview: "art/button.png",
      width: 90,
      height: 70,
      name: { en: "Button", pl: "Przycisk" },
    };
    expect(normalizeManifest(manifest, (path) => "/gizmos/test/" + path).preview).toBe(
      "/gizmos/test/art/button.png",
    );
    for (const preview of [
      "../other.png",
      "%2e%2e/other.png",
      "https://example.test/p.png",
      "//example.test/p.png",
      "image.svg",
      "image.png?param",
    ]) {
      expect(() => normalizeManifest({ ...manifest, preview }, (path) => path)).toThrow();
    }
    expect(() => normalizeManifest({ ...manifest, script: "app.js" }, (path) => path)).toThrow();
    expect(gizmoSource(source.replace("/deck/", "/deck/../"))).toBeNull();
    expect(gizmoSource(source + "?raw=true")).toBeNull();
  });
});
