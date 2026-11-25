import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/index";

import { boardPrefix } from "../src/file-store";
import { MAX_FILE_BYTES, MAX_UPLOADS_PER_MINUTE } from "../src/limits";
import { Browser, roomCall, standaloneEnv } from "./standalone-support";
import { deletion, destroy, pass } from "./support";

const hostedEnv = env as unknown as Env;

// A real 1×1 PNG, and the start of other kinds; the Worker reads only as far
// as it needs to tell them apart.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.codePointAt(0)!,
);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const ascii = (text: string) => new TextEncoder().encode(text);
const WEBP = Uint8Array.from([...ascii("RIFF"), 4, 0, 0, 0, ...ascii("WEBPVP8 ")]);
const AVIF = Uint8Array.from([
  0,
  0,
  0,
  0x1c,
  ...ascii("ftypavif"),
  0,
  0,
  0,
  0,
  ...ascii("avifmif1miaf"),
]);
const GIF = ascii("GIF89a\u0001\u0000\u0001\u0000");
const SVG = ascii(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
);

type Uploaded = { bytes: number; hash: string; src: string; type: string };

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function upload(
  board: string,
  token: string,
  bytes: BodyInit,
  { type = "image/png", workerEnv = hostedEnv }: { type?: string; workerEnv?: Env } = {},
) {
  return roomCall(
    `/rooms/${board}/files`,
    token,
    { body: bytes, headers: { "Content-Type": type }, method: "POST" },
    workerEnv,
  );
}

// What a browser does: trades the pass for the files cookie, then reads the
// image with only that cookie, as an <img> would.
async function readAsImage(board: string, token: string, src: string, workerEnv = hostedEnv) {
  const access = await roomCall(
    `/rooms/${board}/files/access`,
    token,
    { method: "POST" },
    workerEnv,
  );
  if (access.status !== 200) return access;
  const [cookie = ""] = access.headers.getSetCookie()[0]!.split(";");
  const { handle } = await import("../src/index");
  return handle(
    new Request(`https://tabletop.test${src}`, { headers: { Cookie: cookie } }),
    workerEnv,
  );
}

async function objectsOf(board: string) {
  const listed = await hostedEnv.Files.list({ prefix: boardPrefix(board) });
  return listed.objects.map((object) => object.key);
}

describe("uploading an image (hosted)", () => {
  it("stores it under its SHA-256 for every member and guest of the board", async () => {
    const response = await upload("pics", await pass({ board: "pics" }), PNG);

    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as Uploaded;
    const hash = await sha256(PNG);
    expect(uploaded).toEqual({
      bytes: PNG.length,
      hash,
      src: `/rooms/pics/files/${hash}`,
      type: "image/png",
    });

    for (const reader of [
      await pass({ board: "pics", name: "Bo", sub: "u:2" }),
      await pass({ board: "pics", name: "Cy", sub: "g:guest" }),
    ]) {
      const image = await readAsImage("pics", reader, uploaded.src);
      expect(image.status).toBe(200);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
      expect(image.headers.get("Content-Type")).toBe("image/png");
      expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(image.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }
  });

  it("is idempotent: the same bytes again answer the same address and count once", async () => {
    const token = await pass({ board: "twice" });
    const first = (await (await upload("twice", token, PNG)).json()) as Uploaded;

    const again = await upload("twice", await pass({ board: "twice", sub: "u:2" }), PNG, {
      type: "image/jpeg",
    });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(await objectsOf("twice")).toEqual([`boards/twice/${first.hash}`]);
  });

  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
    ["AVIF", AVIF, "image/avif"],
    ["GIF", GIF, "image/gif"],
    ["SVG", SVG, "image/svg+xml"],
  ])("tells %s by its bytes, whatever the upload declared", async (_kind, bytes, type) => {
    const response = await upload("kinds", await pass({ board: "kinds" }), bytes, {
      type: "application/octet-stream",
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as Uploaded).type).toBe(type);
  });

  it("hands an SVG over as a download that runs nothing when opened on its own", async () => {
    const token = await pass({ board: "vector" });
    const { src } = (await (await upload("vector", token, SVG)).json()) as Uploaded;

    const image = await readAsImage("vector", token, src);

    expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(image.headers.get("Content-Disposition")).toMatch(/^attachment; /u);
    expect(image.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it.each([
    ["an HTML page named and declared a PNG", ascii("<!doctype html><script>alert(1)</script>")],
    ["a script declared an image", ascii("alert(document.cookie)")],
    ["an SVG that is not UTF-8", Uint8Array.from([...ascii("<svg>"), 0xff, 0xfe])],
    ["a PDF", ascii("%PDF-1.7\n")],
  ])("refuses %s", async (_label, bytes) => {
    const response = await upload("disguise", await pass({ board: "disguise" }), bytes);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "unsupported" });
    expect(await objectsOf("disguise")).toEqual([]);
  });

  it("refuses an empty body", async () => {
    const response = await upload("empty", await pass({ board: "empty" }), new Uint8Array());

    expect(response.status).toBe(400);
  });

  it("refuses a file over the size cap, declared or not", async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(PNG);
    const token = await pass({ board: "big" });

    const declared = await upload("big", token, big);
    const streamed = await upload("big", token, new Blob([big]).stream());

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    expect(await objectsOf("big")).toEqual([]);
  });

  it("takes a file of exactly the cap", async () => {
    const most = new Uint8Array(MAX_FILE_BYTES);
    most.set(PNG);

    const response = await upload("most", await pass({ board: "most" }), most);

    expect(response.status).toBe(201);
  });

  it("keeps one person to the upload rate and lets the others through", async () => {
    const token = await pass({ board: "rate" });
    const answers = [];
    for (let count = 0; count <= MAX_UPLOADS_PER_MINUTE; count++) {
      const bytes = Uint8Array.from([...PNG, count & 0xff, count >> 8]);
      answers.push((await upload("rate", token, bytes)).status);
    }

    expect(answers.slice(0, MAX_UPLOADS_PER_MINUTE).every((status) => status === 201)).toBe(true);
    expect(answers.at(-1)).toBe(429);
    const other = await upload("rate", await pass({ board: "rate", sub: "u:2" }), JPEG);
    expect(other.status).toBe(201);
  });

  it("refuses an upload that would take the board over its quota", async () => {
    // NOTE: 256 MiB at 10 MiB a file: 25 files fit, the 26th does not.
    const answers: number[] = [];
    for (let count = 0; count < 26; count++) {
      const token = await pass({ board: "quota", sub: `u:${count}` });
      const file = new Uint8Array(MAX_FILE_BYTES);
      file.set(PNG);
      file[MAX_FILE_BYTES - 1] = count;
      answers.push((await upload("quota", token, file)).status);
    }
    const small = await upload("quota", await pass({ board: "quota", sub: "u:x" }), JPEG);

    expect(answers.slice(0, 25)).toEqual(Array.from({ length: 25 }, () => 201));
    expect(answers[25]).toBe(507);
    expect(small.status).toBe(201);
    expect(await objectsOf("quota")).toHaveLength(26);
  }, 60_000);

  it("serves a part of the bytes to a range request", async () => {
    const token = await pass({ board: "range" });
    const { src } = (await (await upload("range", token, PNG)).json()) as Uploaded;

    const part = await roomCall(src, token, { headers: { Range: "bytes=1-3" } }, hostedEnv);

    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 1-3/${PNG.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG.subarray(1, 4));
  });

  it("answers 404 for bytes the board never stored", async () => {
    const response = await readAsImage(
      "pics",
      await pass({ board: "pics" }),
      `/rooms/pics/files/${"0".repeat(64)}`,
    );

    expect(response.status).toBe(404);
  });
});

describe("the board's images stay with the board's people", () => {
  async function stored(board: string) {
    const uploaded = await upload(board, await pass({ board }), PNG);
    return ((await uploaded.json()) as Uploaded).src;
  }

  it("refuses an upload and a read without a pass", async () => {
    const src = await stored("closed");
    const { handle } = await import("../src/index");

    const read = await handle(new Request(`https://board.test${src}`), hostedEnv);
    const sent = await handle(
      new Request("https://board.test/rooms/closed/files", { body: PNG, method: "POST" }),
      hostedEnv,
    );

    expect(read.status).toBe(403);
    expect(sent.status).toBe(403);
  });

  it("refuses another board's pass, in the header and in the cookie", async () => {
    const src = await stored("mine");
    const theirs = await pass({ board: "theirs" });

    expect((await upload("mine", theirs, PNG)).status).toBe(403);
    expect((await roomCall(src, theirs, {}, hostedEnv)).status).toBe(403);
    expect((await readAsImage("mine", theirs, src)).status).toBe(403);
    const { handle } = await import("../src/index");
    const access = await roomCall(
      "/rooms/theirs/files/access",
      theirs,
      { method: "POST" },
      hostedEnv,
    );
    const [cookie = ""] = access.headers.getSetCookie()[0]!.split(";");
    const crossed = await handle(
      new Request(`https://board.test${src}`, { headers: { Cookie: cookie } }),
      hostedEnv,
    );
    expect(crossed.status).toBe(403);
  });

  it("refuses the old link's passes once the link was reset", async () => {
    const src = await stored("reset");
    const old = await pass({ board: "reset" });
    const access = await roomCall("/rooms/reset/files/access", old, { method: "POST" }, hostedEnv);
    const [cookie = ""] = access.headers.getSetCookie()[0]!.split(";");
    expect((await readAsImage("reset", await pass({ board: "reset", link: 1 }), src)).status).toBe(
      200,
    );

    const { handle } = await import("../src/index");
    const byCookie = await handle(
      new Request(`https://board.test${src}`, { headers: { Cookie: cookie } }),
      hostedEnv,
    );

    expect(byCookie.status).toBe(403);
    expect((await upload("reset", old, JPEG)).status).toBe(403);
    expect((await readAsImage("reset", old, src)).status).toBe(403);
  });

  it("sets a cookie scripts cannot read, scoped to the board's files, for the pass's life", async () => {
    const access = await roomCall(
      "/rooms/scoped/files/access",
      await pass({ board: "scoped" }),
      { method: "POST" },
      hostedEnv,
    );

    expect(access.status).toBe(200);
    expect(access.headers.getSetCookie()[0]).toMatch(
      /^tabletop-files=[\w.-]+; Max-Age=(29\d|300); Path=\/rooms\/scoped\/files; Secure; HttpOnly; SameSite=Strict$/u,
    );
  });

  it("does not take the cookie for an upload", async () => {
    const token = await pass({ board: "nocsrf" });
    const access = await roomCall(
      "/rooms/nocsrf/files/access",
      token,
      { method: "POST" },
      hostedEnv,
    );
    const [cookie = ""] = access.headers.getSetCookie()[0]!.split(";");
    const { handle } = await import("../src/index");

    const sent = await handle(
      new Request("https://board.test/rooms/nocsrf/files", {
        body: PNG,
        headers: { Cookie: cookie },
        method: "POST",
      }),
      hostedEnv,
    );

    expect(sent.status).toBe(403);
  });

  it("goes when the host deletes the board", async () => {
    await stored("gone");
    await upload("gone", await pass({ board: "gone" }), JPEG);
    expect(await objectsOf("gone")).toHaveLength(2);
    await upload("kept", await pass({ board: "kept" }), PNG);

    expect((await destroy("gone", await deletion({ board: "gone" }))).status).toBe(204);

    expect(await objectsOf("gone")).toEqual([]);
    expect(await objectsOf("kept")).toHaveLength(1);
    // The quota starts over with the board: the same bytes are stored anew.
    expect((await upload("gone", await pass({ board: "gone" }), PNG)).status).toBe(201);
  });
});

describe("images in standalone mode", () => {
  it("go through the same pass for the owner and a guest, and go with the board", async () => {
    const owner = new Browser();
    await owner.signIn("Ada");
    const board = await owner.createBoard();
    const ownerPass = ((await (await owner.bootstrap(board.shareCode)).json()) as { pass: string })
      .pass;
    const guest = new Browser();
    const guestPass = (
      (await (await guest.bootstrap(board.shareCode, { name: "Bea" })).json()) as { pass: string }
    ).pass;

    const sent = await upload(board.id, guestPass, PNG, { workerEnv: standaloneEnv });
    expect(sent.status).toBe(201);
    const { src } = (await sent.json()) as Uploaded;
    const seen = await readAsImage(board.id, ownerPass, src, standaloneEnv);
    expect(new Uint8Array(await seen.arrayBuffer())).toEqual(PNG);
    // A hosted pass for the same board id opens nothing here.
    expect(
      (await upload(board.id, await pass({ board: board.id }), JPEG, { workerEnv: standaloneEnv }))
        .status,
    ).toBe(403);

    expect((await owner.post(`/api/boards/${board.id}/delete`)).status).toBe(204);

    expect(await objectsOf(board.id)).toEqual([]);
  });
});
