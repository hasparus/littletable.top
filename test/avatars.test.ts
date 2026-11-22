import { createUserId, InstancePresenceRecordType, type TLPageId } from "@tldraw/tlschema";
import { env } from "cloudflare:workers";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

import { pictureOf } from "../e2e/fake-workos";
import { avatarKey, copyAvatar, hostRule, providerRule } from "../src/avatars";
import { MAX_AVATAR_BYTES } from "../src/limits";
import { Browser, ORIGIN, roomCall } from "./standalone-support";
import { pass, seat, until } from "./support";

// People's pictures: what the Worker copies and refuses, that a sign-in
// never waits on one, and that a board shows only the pictures of its own
// people, under the names their passes give them.

const hostedEnv = env as unknown as Env;
const bucket = hostedEnv.Files;
// wrangler.json's HOST_ORIGIN, which the hosted tests trust.
const HOST = "http://localhost:8000";

const PNG = new Uint8Array(pictureOf("someone"));
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4"/>');
const HTML = new TextEncoder().encode("<!doctype html><title>Sign in</title>");

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A stand-in for the network: answers by URL, and counts what was asked.
function network(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new TypeError(`unexpected fetch of ${url}`);
    return answer();
  }) as typeof fetch;
  return { asked, fetcher };
}

const picture =
  (bytes: Uint8Array<ArrayBuffer>, headers: HeadersInit = {}) =>
  () =>
    new Response(bytes, { headers });
const redirect = (to: string) => () =>
  new Response(null, { headers: { Location: to }, status: 302 });

const provider = providerRule("https://api.workos.test");

describe("copying a picture", () => {
  it("keeps the bytes as they came, under their SHA-256, as the type they are", async () => {
    const { fetcher } = network({ "https://pics.test/a.png": picture(PNG) });

    const copy = await copyAvatar({
      bucket,
      fetcher,
      rule: provider,
      url: "https://pics.test/a.png",
    });

    const hash = await sha256(PNG);
    expect(copy).toEqual({ hash });
    const stored = await bucket.get(avatarKey(hash));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
  });

  it.each([
    ["plain http", "http://pics.test/a.png"],
    ["a private address", "https://10.0.0.7/a.png"],
    ["localhost", "https://localhost/a.png"],
    ["an internal name", "https://pics.internal/a.png"],
    ["not a URL", "a.png"],
  ])("refuses %s without asking for it", async (_, url) => {
    const { asked, fetcher } = network({});

    expect(await copyAvatar({ bucket, fetcher, rule: provider, url })).toEqual({
      failure: "not-allowed",
    });
    expect(asked).toEqual([]);
  });

  it("follows a redirect to a public https host, never to a private one", async () => {
    const followed = network({
      "https://pics.test/me": redirect("https://cdn.pics.test/me.png"),
      "https://cdn.pics.test/me.png": picture(PNG),
    });
    expect(
      await copyAvatar({
        bucket,
        fetcher: followed.fetcher,
        rule: provider,
        url: "https://pics.test/me",
      }),
    ).toEqual({ hash: await sha256(PNG) });

    for (const inside of [
      "https://127.0.0.1/me.png",
      "https://169.254.169.254/latest",
      "http://cdn.pics.test/me.png",
    ]) {
      const refused = network({ "https://pics.test/me": redirect(inside) });
      expect(
        await copyAvatar({
          bucket,
          fetcher: refused.fetcher,
          rule: provider,
          url: "https://pics.test/me",
        }),
      ).toEqual({ failure: "not-allowed" });
      expect(refused.asked).toEqual(["https://pics.test/me"]);
    }
  });

  it("gives up after three redirects", async () => {
    const { fetcher } = network({
      "https://pics.test/1": redirect("/2"),
      "https://pics.test/2": redirect("/3"),
      "https://pics.test/3": redirect("/4"),
      "https://pics.test/4": redirect("/5"),
    });
    expect(
      await copyAvatar({ bucket, fetcher, rule: provider, url: "https://pics.test/1" }),
    ).toEqual({
      failure: "redirects",
    });
  });

  it("refuses a picture over the cap, whether or not it says its size", async () => {
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(PNG);
    const declared = network({
      "https://pics.test/big.png": picture(big, { "Content-Length": String(big.length) }),
    });
    const streamed = network({
      "https://pics.test/big.png": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(big.subarray(0, MAX_AVATAR_BYTES));
              controller.enqueue(big.subarray(MAX_AVATAR_BYTES));
              controller.close();
            },
          }),
        ),
    });
    for (const { fetcher } of [declared, streamed]) {
      expect(
        await copyAvatar({ bucket, fetcher, rule: provider, url: "https://pics.test/big.png" }),
      ).toEqual({ failure: "too-large" });
    }
  });

  it.each([
    ["a page", HTML, "not-image"],
    ["an SVG", SVG, "svg"],
  ] as const)("refuses %s, whatever its declared type", async (_, bytes, failure) => {
    const { fetcher } = network({
      "https://pics.test/me.png": picture(bytes, { "Content-Type": "image/png" }),
    });
    expect(
      await copyAvatar({ bucket, fetcher, rule: provider, url: "https://pics.test/me.png" }),
    ).toEqual({
      failure,
    });
  });

  it("refuses an error answer", async () => {
    const { fetcher } = network({
      "https://pics.test/gone.png": () => new Response("gone", { status: 404 }),
    });
    expect(
      await copyAvatar({ bucket, fetcher, rule: provider, url: "https://pics.test/gone.png" }),
    ).toEqual({ failure: "status" });
  });

  it("stops waiting for a slow host, before it answers or while it sends", async () => {
    const silent = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const trickling = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(PNG.subarray(0, 8));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
      )) as typeof fetch;
    for (const fetcher of [silent, trickling]) {
      expect(
        await copyAvatar({
          bucket,
          fetcher,
          rule: provider,
          timeoutMs: 50,
          url: "https://pics.test/slow.png",
        }),
      ).toEqual({ failure: "timeout" });
    }
  });

  it("in hosted mode, fetches from the host's origin only, redirects included", async () => {
    const elsewhere = network({});
    expect(
      await copyAvatar({
        bucket,
        fetcher: elsewhere.fetcher,
        rule: hostRule(HOST),
        url: "https://pics.test/a.png",
      }),
    ).toEqual({ failure: "not-allowed" });
    expect(elsewhere.asked).toEqual([]);

    const away = network({ [`${HOST}/avatars/1.png`]: redirect("https://pics.test/a.png") });
    expect(
      await copyAvatar({
        bucket,
        fetcher: away.fetcher,
        rule: hostRule(HOST),
        url: `${HOST}/avatars/1.png`,
      }),
    ).toEqual({ failure: "not-allowed" });
    expect(away.asked).toEqual([`${HOST}/avatars/1.png`]);
  });
});

type Me = { account: { avatar: string | null; name: string } | null };

describe("a standalone account's picture", () => {
  it("is copied at sign-in and shown to the account alone", async () => {
    const ada = new Browser();
    await ada.signIn("Ada Lovelace");
    const { account } = (await (await ada.fetch("/api/me")).json()) as Me;

    const own = await ada.fetch(account!.avatar!);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("image/png");
    expect(own.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(own.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await own.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const bea = new Browser();
    await bea.signIn("Bea");
    expect((await bea.fetch(account!.avatar!)).status).toBe(404);
    expect((await new Browser().fetch(account!.avatar!)).status).toBe(404);
  });

  it("does not hold up a sign-in whose picture fails, and is gone when the provider drops it", async () => {
    const ada = new Browser();
    await ada.signIn("Ada Lovelace", { picture: "broken" });
    expect(await (await ada.fetch("/api/me")).json()).toMatchObject({
      account: { avatar: null, name: "Ada Lovelace" },
    });

    const cy = new Browser();
    await cy.signIn("Cy");
    expect(((await (await cy.fetch("/api/me")).json()) as Me).account!.avatar).not.toBeNull();
    await cy.signIn("Cy", { picture: "none" });
    expect(((await (await cy.fetch("/api/me")).json()) as Me).account!.avatar).toBeNull();
  });

  it("goes into the member's pass and onto the board; a guest has none", async () => {
    const owner = new Browser();
    await owner.signIn("Grace");
    const board = await owner.createBoard();
    const { pass: ownerPass } = (await (await owner.bootstrap(board.shareCode)).json()) as {
      pass: string;
    };
    const guest = new Browser();
    const { pass: guestPass } = (await (
      await guest.bootstrap(board.shareCode, { name: "Noor" })
    ).json()) as { pass: string };

    expect(decodeJwt(ownerPass).avatar).toMatch(/^[0-9a-f]{64}$/u);
    expect(decodeJwt(guestPass)).not.toHaveProperty("avatar");

    const access = async (token: string) =>
      (await (
        await roomCall(`/rooms/${board.id}/files/access`, token, { method: "POST" })
      ).json()) as { avatar: string | null };
    const { avatar } = await access(ownerPass);
    expect(avatar).toBe(`/rooms/${board.id}/files/avatars/${String(decodeJwt(ownerPass).avatar)}`);
    expect(await access(guestPass)).toEqual({ avatar: null });

    // The guest, on the board, sees the owner's picture.
    const seen = await roomCall(avatar!, guestPass);
    expect(seen.status).toBe(200);
    expect(seen.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("a hosted board's pictures", () => {
  it("copies the picture the host signed into the pass, from the host's origin", async () => {
    const token = await pass({
      avatar: `${HOST}/avatars/user_0123456789abcdef0123.png`,
      board: "pictured",
    });

    const avatar = await accessOf("pictured", token);

    const expected = await sha256(new Uint8Array(pictureOf("user_0123456789abcdef0123")));
    expect(avatar).toBe(`/rooms/pictured/files/avatars/${expected}`);
    const shown = await roomCall(avatar!, token, {}, hostedEnv);
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(
      new Uint8Array(pictureOf("user_0123456789abcdef0123")),
    );
  });

  it("takes no picture from another origin, even signed", async () => {
    const token = await pass({
      avatar: `${ORIGIN}/avatars/user_0123456789abcdef0123.png`,
      board: "elsewhere",
    });
    expect(await accessOf("elsewhere", token)).toBeNull();
  });

  it("shows a picture only to the boards its person is on", async () => {
    const ada = await pass({
      avatar: `${HOST}/avatars/user_aaaaaaaaaaaaaaaaaaaa.png`,
      board: "adas",
      sub: "u:ada",
    });
    const avatar = await accessOf("adas", ada);
    const hash = avatar!.split("/").at(-1)!;

    const stranger = await pass({ board: "strangers", sub: "u:cy" });
    expect(
      (await roomCall(`/rooms/strangers/files/avatars/${hash}`, stranger, {}, hostedEnv)).status,
    ).toBe(404);
    expect((await roomCall(avatar!, stranger, {}, hostedEnv)).status).toBe(403);
    expect(
      (await roomCall(`/rooms/adas/files/avatars/${"0".repeat(64)}`, ada, {}, hostedEnv)).status,
    ).toBe(404);
  });
});

type Patch = { diff?: Record<string, [string, Record<string, unknown>]>; type: string };

describe("presence on a board", () => {
  it("carries the pass's id, name and picture, whatever a client claims", async () => {
    const board = "masks";
    const avatar = `${HOST}/avatars/user_bbbbbbbbbbbbbbbbbbbb.png`;
    const ada = await seat(board, await pass({ avatar, board, name: "Ada", sub: "u:ada" }));
    const adaPicture = (await accessOf(
      board,
      await pass({ avatar, board, name: "Ada", sub: "u:ada" }),
    ))!
      .split("/")
      .at(-1);
    const mallory = await seat(board, await pass({ board, name: "Mallory", sub: "g:mallory" }));

    const id = InstancePresenceRecordType.createId();
    mallory.send({
      clientClock: 1,
      presence: [
        "put",
        InstancePresenceRecordType.create({
          currentPageId: "page:page" as TLPageId,
          id,
          meta: { avatar: adaPicture },
          userId: createUserId("u:ada"),
          userName: "Ada",
        }),
      ],
      type: "push",
    });
    const presenceSeen = () =>
      (ada.received as (Patch | { data: Patch[]; type: "data" })[])
        .flatMap((message) => ("data" in message ? message.data : [message]))
        .filter((message) => message.type === "patch")
        .flatMap((message) => Object.values(message.diff ?? {}))
        .map(([, record]) => record)
        .find((record) => record.typeName === "instance_presence");
    await until(() => presenceSeen() !== undefined);

    expect(presenceSeen()).toMatchObject({
      meta: { avatar: null },
      userId: "user:g:mallory",
      userName: "Mallory",
    });

    mallory.send({
      clientClock: 2,
      presence: ["patch", { userName: ["put", "Ada"], userId: ["put", "user:u:ada"] }],
      type: "push",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Ada never sent a presence of her own: nothing Ada received may name her.
    const everything = JSON.stringify(ada.received);
    expect(everything).not.toContain("user:u:ada");
    expect(everything).not.toContain(adaPicture);
    expect(everything).not.toContain('"Ada"');
  });
});

async function accessOf(board: string, token: string) {
  const response = await roomCall(
    `/rooms/${board}/files/access`,
    token,
    { method: "POST" },
    hostedEnv,
  );
  return ((await response.json()) as { avatar: string | null }).avatar;
}
