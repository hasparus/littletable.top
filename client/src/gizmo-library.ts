import type { PassKeeper } from "./bootstrap";

import { type InstalledGizmo, normalizeManifest } from "../../src/gizmo-packages";

export async function loadPracticeGizmos() {
  const signal = AbortSignal.timeout(15_000);
  const catalog = await fetch("/gizmos/catalog.json", { signal });
  if (!catalog.ok) throw new Error("Practice catalog unavailable");
  const urls: string[] = await catalog.json();
  return Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error("Practice package unavailable");
      const manifest = normalizeManifest(
        await response.json(),
        (path) => new URL(path, response.url).pathname,
      );
      return { url, manifest };
    }),
  );
}

export async function roomGizmos(keeper: PassKeeper, signal: AbortSignal) {
  const response = await fetch(`${keeper.room}/gizmos`, {
    signal,
    headers: { Authorization: `Bearer ${await keeper.pass()}` },
  });
  if (!response.ok) throw new Error("Gizmo gallery unavailable");
  const pieces: InstalledGizmo[] = await response.json();
  return pieces;
}

export async function installGizmo(keeper: PassKeeper, url: string) {
  const response = await fetch(`${keeper.room}/gizmos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await keeper.pass()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error("Install failed");
  const piece: InstalledGizmo = await response.json();
  return piece;
}
