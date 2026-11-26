import registry from "../gizmos/registry.json";
import { readCapped, sha256Hex } from "./file-store";
import { gizmoInstallRequest, type GizmoSubmission } from "./gizmo-packages";
import { pinGizmoSource } from "./gizmo-store";
import { addressKey, type Limiter } from "./limiter";

const repository = "hasparus/littletable.top";
const github = "https://github.com/" + repository;

export async function submitGizmo(
  request: Request,
  token: string | undefined,
  limiter: DurableObjectNamespace<Limiter>,
) {
  const headers = { "Cache-Control": "no-store" };
  const reply = (status: number) => new Response(null, { status, headers });
  if (request.method !== "POST") return reply(405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403);
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return reply(415);
  const bytes = await readCapped(request.body, {
    declared: Number(request.headers.get("Content-Length")),
    max: 4096,
  });
  if (bytes === "too-large") return reply(413);
  const body: unknown = await new Response(bytes).json().catch(() => null);
  if (!gizmoInstallRequest.isValid(body)) return reply(400);
  const allowed = await limiter
    .get(limiter.idFromName(await addressKey(request)))
    .take("gizmo-submissions", 5, 60_000);
  if (!allowed) return reply(429);
  const source = await pinGizmoSource(fetch, body.url).catch(() => null);
  if (!source) return reply(502);
  if ("error" in source) return reply(source.status);
  if (registry.some((entry) => entry.url === source.url)) {
    return Response.json({ status: "listed" } satisfies GizmoSubmission, { headers });
  }

  if (token) {
    const endpoint =
      "https://api.github.com/repos/" +
      repository +
      "/actions/workflows/gizmo-submission.yml/dispatches";
    const sent = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "Little-Table-Gizmos",
      },
      body: JSON.stringify({ ref: "main", inputs: { source: source.url } }),
    }).catch(() => null);
    await sent?.body?.cancel();
    if (sent?.ok) {
      const key = await sha256Hex(new TextEncoder().encode(source.url).buffer);
      const search = new URLSearchParams({ q: "is:pr head:gizmo-submission/" + key });
      return Response.json(
        { status: "queued", url: github + "/pulls?" + search } satisfies GizmoSubmission,
        { status: 202, headers },
      );
    }
  }

  const issue = new URLSearchParams({ title: "Submit Gizmo to marketplace", body: source.url });
  return Response.json(
    { status: "confirm", url: github + "/issues/new?" + issue } satisfies GizmoSubmission,
    { headers },
  );
}
