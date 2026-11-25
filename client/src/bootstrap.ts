export type { Roll } from "../../src/dice-notation";

export type Person = {
  id: string;
  name: string;
  owner: boolean;
  role?: "owner" | "shaman" | "write";
};

/** What the pass endpoint answers (docs/hosting.md, "The host contract"). */
export type Bootstrap = {
  /** The board's id: its room is /rooms/<board> on this origin. */
  board: string;
  /** Where a member finds their boards; null for a guest. */
  boardsUrl: string | null;
  pass: string;
  person: Person;
  /** The Worker adds this only for the signed-in owner of a standalone account board. */
  secretPass?: string;
  publication?: { csrf: string; url: string | null };
  /** The place on the host the board belongs to, where a guest leaves to. */
  home: { name: string; url: string };
  /** Only an authenticated member on a standalone private board may refresh its thumbnail. */
  thumbnail?: { csrf: string; link: number; needed: boolean };
  title: string;
};

export type Answer =
  | { bootstrap: Bootstrap; kind: "ready" }
  | { kind: "failed" | "gone" | "link-reset" | "throttled" }
  | { kind: "name-invalid" | "name-required" };

export type Door = { bootstrapUrl: string; credentials: RequestCredentials };

/**
 * NOTE: in hosted mode the request crosses origins with the host's session
 * cookie, which the two hosts share as one site. The host answers only this
 * origin, and the JSON content type makes the browser ask it first (a CORS
 * preflight).
 */
export async function knock(door: Door, name?: string): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(door.bootstrapUrl, {
      body: JSON.stringify(name === undefined ? {} : { name }),
      credentials: door.credentials,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    console.error("board: bootstrap unreachable", error);
    return { kind: "failed" };
  }
  if (response.status === 404) return { kind: "gone" };
  if (response.status === 429) return { kind: "throttled" };
  const body: unknown = await response.json().catch(() => null);
  const refusal = body as { error?: string } | null;
  if (response.status === 403 && refusal?.error === "link-reset") return { kind: "link-reset" };
  if (
    response.status === 422 &&
    (refusal?.error === "name-required" || refusal?.error === "name-invalid")
  ) {
    return { kind: refusal.error };
  }
  if (!response.ok || body === null) {
    console.error("board: bootstrap refused", response.status);
    return { kind: "failed" };
  }
  return { bootstrap: body as Bootstrap, kind: "ready" };
}

// WARNING: Passes expire after five minutes. Refresh before then to leave time for the request.
const PASS_REUSE_MS = 4 * 60_000;

export type Ending = "gone" | "link-reset";

/**
 * Keeps a usable pass for one board: the socket asks for one on every
 * (re)connect, and each roll request carries one.
 */
export class PassKeeper {
  private latest: Bootstrap;
  private issuedAt = Date.now();
  private pending: Promise<Bootstrap> | null = null;

  constructor(
    private readonly door: Door,
    first: Bootstrap,
    private readonly onEnding: (ending: Ending) => void,
    readonly secret = false,
  ) {
    this.latest = first;
  }

  get bootstrap(): Bootstrap {
    return this.latest;
  }

  forSecret(onEnding: (ending: Ending) => void): PassKeeper {
    const keeper = new PassKeeper(this.door, this.latest, onEnding, true);
    keeper.issuedAt = this.issuedAt;
    return keeper;
  }

  async pass(): Promise<string> {
    const current = Date.now() - this.issuedAt < PASS_REUSE_MS ? this.latest : await this.renew();
    if (!this.secret) return current.pass;
    if (current.secretPass !== undefined) return current.secretPass;
    this.end("link-reset");
    throw new Error("board: secret layer is no longer available");
  }

  async socketUri(): Promise<string> {
    const pass = await this.pass();
    const origin = location.origin.replace(/^http/u, "ws");
    return `${origin}${this.room}/connect?pass=${encodeURIComponent(pass)}`;
  }

  get room(): string {
    return `/rooms/${this.latest.board}${this.secret ? "/secret" : ""}`;
  }

  end(ending: Ending): void {
    this.onEnding(ending);
  }

  private renew(): Promise<Bootstrap> {
    this.pending ??= knock(this.door)
      .then((answer) => {
        if (answer.kind === "ready") {
          this.latest = answer.bootstrap;
          this.issuedAt = Date.now();
          return answer.bootstrap;
        }
        if (answer.kind === "gone") this.end("gone");
        else if (answer.kind === "name-required" || answer.kind === "link-reset") {
          this.end("link-reset");
        }
        throw new Error(`board: pass renewal ${answer.kind}`);
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
