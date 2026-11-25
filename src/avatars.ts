import { readCapped, sha256Hex, sniff } from "./file-store";
import { AVATAR_TIMEOUT_MS, MAX_AVATAR_BYTES, MAX_AVATAR_REDIRECTS } from "./limits";

export const AVATAR = /^[0-9a-f]{64}$/u;

// WARNING: Deleting one board must leave avatars intact because other boards and accounts share them.
export const avatarKey = (hash: string) => `avatars/${hash}`;

export type AvatarFailure =
  | "not-allowed"
  | "not-image"
  | "redirects"
  | "status"
  | "svg"
  | "timeout"
  | "too-large"
  | "unreachable";

export type AvatarCopy = { failure: AvatarFailure } | { hash: string };

// WARNING: Reapply the avatar policy on every redirect so an allowed origin cannot bypass it.
export type AvatarRule = (url: URL) => boolean;

// WARNING: Reject address literals and private network names before issuing avatar requests.
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || /\.(?:localhost|local|internal|home\.arpa)$/u.test(host)) {
    return true;
  }
  return /^\d+(?:\.\d+){0,3}$/u.test(host) || /^0x[0-9a-f]+$/u.test(host) || host.startsWith("[");
}

/** Trusts the configured sign-in API origin. Other origins must use HTTPS and a public host name. */
export const providerRule =
  (apiBase: string): AvatarRule =>
  (url) =>
    url.origin === new URL(apiBase).origin ||
    (url.protocol === "https:" && !isPrivateHost(url.hostname));

/** Restricts hosted avatar copies to the host origin, including every redirect. */
export const hostRule =
  (hostOrigin: string): AvatarRule =>
  (url) =>
    url.origin === hostOrigin;

const isRedirect = (status: number) => status >= 300 && status < 400;

async function fetchPicture(
  first: URL,
  { fetcher, rule, signal }: { fetcher: typeof fetch; rule: AvatarRule; signal: AbortSignal },
): Promise<ArrayBuffer | AvatarFailure> {
  let url = first;
  for (let hops = 0; ; hops++) {
    if (!rule(url)) return "not-allowed";
    const response = await fetcher(url, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "manual",
      signal,
    });
    const location = response.headers.get("Location");
    if (isRedirect(response.status) && location !== null) {
      await response.body?.cancel();
      if (hops >= MAX_AVATAR_REDIRECTS) return "redirects";
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return "status";
    }
    return readCapped(response.body, {
      declared: Number(response.headers.get("Content-Length") ?? "0"),
      max: MAX_AVATAR_BYTES,
    });
  }
}

/**
 * Copies an avatar for same-origin delivery without exposing players' browsers
 * to the identity provider. Copy failures leave sign-in and board entry usable.
 */
export async function copyAvatar({
  bucket,
  fetcher = fetch,
  rule,
  timeoutMs = AVATAR_TIMEOUT_MS,
  url,
}: {
  bucket: R2Bucket;
  fetcher?: typeof fetch;
  rule: AvatarRule;
  timeoutMs?: number;
  url: string;
}): Promise<AvatarCopy> {
  let first: URL;
  try {
    first = new URL(url);
  } catch {
    return { failure: "not-allowed" };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let body: ArrayBuffer | AvatarFailure;
  try {
    body = await fetchPicture(first, { fetcher, rule, signal });
  } catch {
    return { failure: signal.aborted ? "timeout" : "unreachable" };
  }
  if (typeof body === "string") return { failure: body };
  // WARNING: Reject SVG avatars because they can contain active document content.
  const type = sniff(new Uint8Array(body));
  if (type === null) return { failure: "not-image" };
  if (type === "image/svg+xml") return { failure: "svg" };
  const hash = await sha256Hex(body);
  const key = avatarKey(hash);
  try {
    if ((await bucket.head(key)) === null) {
      await bucket.put(key, body, { httpMetadata: { contentType: type }, sha256: hash });
    }
  } catch {
    return { failure: "unreachable" };
  }
  return { hash };
}

export function logAvatar(fields: {
  copy: AvatarCopy;
  mode: "hosted" | "standalone";
  person: "guest" | "member";
}) {
  const { copy, mode, person } = fields;
  console.log(
    JSON.stringify({
      event: "avatar.copied",
      mode,
      outcome: "hash" in copy ? "stored" : copy.failure,
      person,
    }),
  );
}
