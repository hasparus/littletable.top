import { env } from "cloudflare:workers";
import { expect } from "vitest";

import { FAKE_API_KEY, FAKE_CLIENT_ID } from "../e2e/fake-workos";
import { type Env, handle } from "../src/index";

const testEnv = env as unknown as Env & { STANDALONE_SIGNING_KEY: string };

export const ORIGIN = "https://tabletop.test";

// The same Worker as the hosted tests, configured as a standalone tabletop
// whose sign-in provider is the fake WorkOS (vitest.config.ts).
export const standaloneEnv: Env = {
  ...testEnv,
  HOST_ORIGIN: undefined,
  ISSUER: undefined,
  ISSUER_PUBLIC_KEY: undefined,
  SIGNING_KEY: testEnv.STANDALONE_SIGNING_KEY,
  TABLETOP_MODE: "standalone",
  WORKOS_API_BASE: "https://workos.test",
  WORKOS_API_KEY: FAKE_API_KEY,
  WORKOS_CLIENT_ID: FAKE_CLIENT_ID,
};

let addresses = 0;

// One browser: a cookie jar, its own address, and redirects left to the
// test to follow.
export class Browser {
  // Each browser is a different person, even under a name another one uses.
  readonly cookies = new Map<string, string>();
  csrf: string | null = null;
  readonly address = `198.18.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;

  async fetch(path: string, init: RequestInit = {}, workerEnv: Env = standaloneEnv) {
    const headers = new Headers(init.headers);
    headers.set("CF-Connecting-IP", this.address);
    if (this.cookies.size > 0) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await handle(
      new Request(new URL(path, ORIGIN), { ...init, headers, redirect: "manual" }),
      workerEnv,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const [name = "", ...value] = pair.split("=");
      const gone = attributes.some((attribute) => attribute.trim() === "Max-Age=0");
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    return response;
  }

  post(path: string, body: object = {}, headers: HeadersInit = {}) {
    return this.fetch(path, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(this.csrf === null ? {} : { "X-CSRF-Token": this.csrf }),
        ...headers,
      },
      method: "POST",
    });
  }

  // The redirect sign-in, start to finish: out to the provider, which knows
  // this person by name, and back to the callback.
  async signIn(
    name: string,
    { picture = "" }: { picture?: "" | "broken" | "none" } = {},
  ): Promise<void> {
    const started = await this.fetch("/auth/sign-in?return=/");
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("Location")!);
    authorize.searchParams.set("fake_user", name);
    authorize.searchParams.set("fake_id", this.address);
    if (picture !== "") authorize.searchParams.set("fake_picture", picture);
    const granted = await fetch(authorize, { redirect: "manual" });
    const callback = new URL(granted.headers.get("Location")!);
    const back = await this.fetch(callback.pathname + callback.search);
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe("/");
    const me = (await (await this.fetch("/api/me")).json()) as { csrf: string };
    this.csrf = me.csrf;
  }

  async createBoard(
    title = "Night one",
  ): Promise<{ id: string; shareCode: string; title: string }> {
    const response = await this.post("/api/boards", { title });
    expect(response.status).toBe(201);
    return response.json();
  }

  async bootstrap(shareCode: string, body: object = {}) {
    return this.post(`/api/b/${shareCode}/bootstrap`, body);
  }

  async list() {
    const response = await this.fetch("/api/boards");
    return (await response.json()) as {
      owned: { id: string; shareCode: string; title: string }[];
      visited: { id: string; shareCode: string | null; title: string }[];
    };
  }
}

export async function openSocket(board: string, pass: string, workerEnv: Env = standaloneEnv) {
  const response = await handle(
    new Request(`${ORIGIN}/rooms/${board}/connect?sessionId=${crypto.randomUUID()}&pass=${pass}`, {
      headers: { Upgrade: "websocket" },
    }),
    workerEnv,
  );
  const socket = (response as unknown as { webSocket: WebSocket | null }).webSocket;
  const closure = new Promise<{ code: number; reason: string }>((resolve) =>
    socket?.addEventListener("close", ({ code, reason }) => resolve({ code, reason })),
  );
  socket?.accept();
  return { closure, response, socket };
}

export function roomCall(
  path: string,
  pass: string,
  init: RequestInit = {},
  workerEnv = standaloneEnv,
) {
  return handle(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${pass}`, ...init.headers },
    }),
    workerEnv,
  );
}
