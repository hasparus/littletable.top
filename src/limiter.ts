import { DurableObject } from "cloudflare:workers";

// A fixed-window counter, one object per hashed client address: no address
// is stored in the clear, and each object forgets a window once it passes.
export class Limiter extends DurableObject {
  private windows = new Map<string, { count: number; window: number }>();

  take(bucket: string, limit: number, windowMs: number): boolean {
    const window = Math.floor(Date.now() / windowMs);
    const current = this.windows.get(bucket);
    const count = current?.window === window ? current.count : 0;
    if (count >= limit) return false;
    this.windows.set(bucket, { count: count + 1, window });
    return true;
  }
}

export async function addressKey(request: Request): Promise<string> {
  // WARNING: Clients can spoof ordinary forwarding headers to evade per-address limits.
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
