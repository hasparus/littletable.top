import type { PassKeeper } from "./bootstrap";

import registry from "../../gizmos/registry.json";
import {
  type GizmoRequest,
  type GizmoDecision,
  type InstalledGizmo,
  normalizeManifest,
} from "../../src/gizmo-packages";

export async function loadPracticeGizmo(url: string) {
  if (!registry.some((entry) => entry.url === url)) throw new Error("Unknown practice package");
  const path = url.slice(url.indexOf("/gizmos/"));
  const response = await fetch(path, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Practice package unavailable");
  const manifest = normalizeManifest(
    await response.json(),
    (asset) => new URL(asset, response.url).pathname,
  );
  return { url, manifest } satisfies InstalledGizmo;
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

export async function roomGizmoRequests(keeper: PassKeeper, signal: AbortSignal) {
  const response = await fetch(`${keeper.room}/gizmo-requests`, {
    signal,
    headers: { Authorization: `Bearer ${await keeper.pass()}` },
  });
  if (!response.ok) throw new Error("Gizmo requests unavailable");
  const entries: GizmoRequest[] = await response.json();
  return entries;
}

export async function changeGizmoRequest(
  keeper: PassKeeper,
  change: GizmoDecision | { url: string },
) {
  const response = await fetch(`${keeper.room}/gizmo-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await keeper.pass()}`, "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error("Gizmo request failed");
  const entry: GizmoRequest = await response.json();
  return entry;
}
