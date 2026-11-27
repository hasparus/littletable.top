import { DurableObject } from "cloudflare:workers";

/** Counts takes per key in fixed windows. */
export class FixedWindows {
  private windows = new Map<string, { count: number; window: number }>();

  take(key: string, limit: number, windowMs: number): boolean {
    const window = Math.floor(Date.now() / windowMs);
    const current = this.windows.get(key);
    const count = current?.window === window ? current.count : 0;
    if (count >= limit) return false;
    this.windows.set(key, { count: count + 1, window });
    return true;
  }
}

/** Counts requests in a fixed window per hashed client address without storing raw addresses. */
export class Limiter extends DurableObject {
  private windows = new FixedWindows();

  take(bucket: string, limit: number, windowMs: number): boolean {
    return this.windows.take(bucket, limit, windowMs);
  }
}

export async function addressKey(request: Request) {
  // WARNING: Clients can spoof ordinary forwarding headers to evade per-address limits.
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
