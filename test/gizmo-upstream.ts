import { Buffer } from "node:buffer";

// Used by Miniflare's outbound service; no network access is needed to install the fixtures.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6tkAAAAASUVORK5CYII=",
  "base64",
);
const name = { en: "Moon", pl: "Księżyc" };
const deck = {
  version: 1,
  kind: "deck",
  name,
  preview: "back.png",
  width: 86,
  height: 148,
  back: "back.png",
  backWidth: 380,
  cardHeight: 640,
  cards: [{ id: "moon", name, width: 380, src: "front.png" }],
};
export function fakeGizmoUpstream(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.hostname === "api.github.com")
    return url.pathname === "/repos/test/gizmos/commits/main"
      ? new Response("1".repeat(40))
      : new Response(null, { status: 404 });
  if (url.hostname !== "raw.githubusercontent.com") return undefined;
  const prefix = "/test/gizmos/" + "1".repeat(40) + "/";
  const path = url.pathname.slice(prefix.length);
  if (!url.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
  if (path === "deck/gizmo.json") return Response.json(deck);
  if (path === "deck/front.png" || path === "deck/back.png")
    return new Response(new Uint8Array(png));
  if (path === "bad/gizmo.json") return Response.json({ ...deck, preview: "relative.svg" });
  if (path === "large/gizmo.json") return new Response(" ".repeat(65537));
  if (path === "text/gizmo.json") return Response.json(deck);
  if (path === "text/back.png") return new Response("ordinary text");
  if (path === "redirect/gizmo.json")
    return Response.redirect(
      new URL("deck/gizmo.json", "https://raw.githubusercontent.com" + prefix),
    );
  return new Response(null, { status: 404 });
}
