import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { FileLedger } from "../src/file-store";
import type { Env } from "../src/index";
import type { Pass } from "../src/pass";

import { boardPrefix, textKey } from "../src/file-store";
import {
  MAX_BOARD_FILE_BYTES,
  MAX_TEXT_FAILURES,
  MAX_TEXT_WRITES_PER_MINUTE,
  TEXT_LEASE_MS,
} from "../src/limits";
import { type EngineKey, TEXT_ENGINES, type TextListing } from "../src/text-result";
import { TextLedger } from "../src/text-store";
import { IMAGES_37_BY_21 } from "./image-samples";
import { call, deletion, destroy, pass, seat, until } from "./support";

// What can go wrong with the text read off a board's images, on the
// Worker's side: a stranger, or a pass for another board, reads or writes
// a board's readings; a reading lands for an image the board does not
// have, of another size, or by an engine nobody allowed; a second reading
// replaces the first; one person floods the board with writes; text fills
// the board past its quota; two browsers are handed the same image, a
// browser that left keeps its image forever, or an image that always
// fails is handed out forever; the room does not tell the others a
// reading is there; and deleting the board leaves the readings behind.

const hostedEnv = env as unknown as Env;
const PNG = IMAGES_37_BY_21["size.png"];
const JPEG = IMAGES_37_BY_21["size.jpg"];
const TESSERACT: EngineKey = "tesseract-6.0.1";
const PPOCR: EngineKey = "ppocr-v6tiny.1";

async function upload(
  board: string,
  token: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const response = await call(`/rooms/${board}/files`, token, { body: bytes, method: "POST" });
  return ((await response.json()) as { hash: string }).hash;
}

function result(hash: string, engine: EngineKey, words: string[] = ["Gród", "Żółwia"]) {
  const { model, name, version } = TEXT_ENGINES[engine];
  return {
    engine: { model, name, params: {}, version },
    format: "ocr/1",
    image: { height: 21, sha256: hash, width: 37 },
    lines: [
      {
        box: [1, 1, 36, 20],
        words: words.map((t, at) => ({ b: [1 + at * 10, 1, 9 + at * 10, 20], c: 0.9, t })),
      },
    ],
    source: "uploader",
  };
}

const put = (board: string, token: string | null, hash: string, engine: string, body: unknown) =>
  call(`/rooms/${board}/files/${hash}/text/${engine}`, token, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    method: "PUT",
  });

const post = (board: string, token: string, action: string, body: unknown) =>
  call(`/rooms/${board}/files/text/${action}`, token, {
    body: JSON.stringify(body),
    method: "POST",
  });

async function listing(board: string, token: string): Promise<TextListing> {
  const response = await call(`/rooms/${board}/files/text`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as TextListing;
}

describe("storing what was read off an image", () => {
  it("keeps the first valid reading and answers any later one with it", async () => {
    const token = await pass({ board: "read" });
    const hash = await upload("read", token, PNG);

    const first = await put("read", token, hash, TESSERACT, result(hash, TESSERACT));
    expect(first.status).toBe(201);
    const stored = (await first.json()) as { createdAt: string; lines: unknown[] };
    expect(stored.lines).toEqual(result(hash, TESSERACT).lines);

    const other = await pass({ board: "read", sub: "u:2" });
    const second = await put("read", other, hash, TESSERACT, result(hash, TESSERACT, ["Inny"]));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(stored);

    const read = await call(`/rooms/read/files/${hash}/text/${TESSERACT}`, other);
    expect(read.status).toBe(200);
    expect(read.headers.get("Content-Type")).toBe("application/json");
    expect(read.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(read.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await read.json()).toEqual(stored);
    expect(await listing("read", other)).toEqual({
      failed: [],
      reading: [],
      stored: [{ engine: TESSERACT, hash }],
    });
  });

  it.each(["before", "after"] as const)(
    "recovers the first result when a room restarts %s the R2 write",
    async (restart) => {
      const board = `recover-reading-${restart}`;
      const token = await pass({ board });
      const hash = await upload(board, token, PNG);
      const createdAt = new Date(1000).toISOString();
      const reserved = { ...result(hash, TESSERACT), createdAt };
      const body = JSON.stringify(reserved);
      const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));
      await runInDurableObject(room, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO texts (hash, engine, bytes, words, at, pending_body) VALUES (?, ?, ?, ?, ?, ?)",
          hash,
          TESSERACT,
          new TextEncoder().encode(body).byteLength,
          2,
          1000,
          body,
        );
      });
      const key = textKey(board, hash, TESSERACT);
      if (restart === "after") await hostedEnv.Files.put(key, body);
      await evictDurableObject(room);

      const [retried, listed] = await Promise.all([
        put(board, token, hash, TESSERACT, result(hash, TESSERACT, ["Inny"])),
        listing(board, token),
      ]);
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual(reserved);
      if (listed.recoveryDelay !== undefined) {
        await expect
          .poll(() => listing(board, token))
          .toMatchObject({
            stored: [{ engine: TESSERACT, hash }],
          });
      } else {
        expect(listed.stored).toEqual([{ engine: TESSERACT, hash }]);
      }
      expect(await (await hostedEnv.Files.get(key))!.text()).toEqual(body);
      await runInDurableObject(room, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT ready, pending_body FROM texts").toArray()).toEqual([
          { pending_body: null, ready: 1 },
        ]);
      });
    },
  );

  it("keeps completed legacy readings and lets a reader reclaim a missing legacy result", async () => {
    const board = "legacy-reading";
    const token = await pass({ board });
    const hash = await upload(board, token, PNG);
    const done = await put(board, token, hash, TESSERACT, result(hash, TESSERACT));
    const first = await done.json();
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec("UPDATE texts SET ready = 0");
      state.storage.sql.exec(
        "INSERT INTO texts (hash, engine, bytes, words, at) VALUES (?, ?, ?, ?, ?)",
        hash,
        PPOCR,
        MAX_BOARD_FILE_BYTES,
        1,
        1,
      );
    });
    await evictDurableObject(room);

    await expect
      .poll(() => listing(board, token))
      .toEqual({
        failed: [],
        reading: [],
        stored: [{ engine: TESSERACT, hash }],
      });
    const claimed = await post(board, token, "claim", {
      candidates: [hash],
      engines: [PPOCR, TESSERACT],
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ engines: [PPOCR], hash });
    expect((await put(board, token, hash, PPOCR, result(hash, PPOCR))).status).toBe(201);
    expect(
      await (await put(board, token, hash, TESSERACT, result(hash, TESSERACT, ["New"]))).json(),
    ).toEqual(first);
  });

  it("lists verified readings while failed repairs wait and later rows recover", async () => {
    const board = "partial-reading-recovery";
    const token = await pass({ board });
    const hash = await upload(board, token, PNG);
    expect((await put(board, token, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(201);

    const legacy = await upload(board, token, JPEG);
    const legacyBody = JSON.stringify(result(legacy, TESSERACT));
    await hostedEnv.Files.put(textKey(board, legacy, TESSERACT), legacyBody);
    const interrupted = Array.from({ length: 6 }, (_, at) => String(at).repeat(64));
    await Promise.all(
      interrupted.map((missing) => hostedEnv.Files.put(textKey(board, missing, TESSERACT), "null")),
    );

    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));
    await runInDurableObject(room, (_instance, state) => {
      const { sql } = state.storage;
      for (const missing of interrupted) {
        sql.exec(
          "INSERT INTO texts (hash, engine, bytes, words, at, pending_body) VALUES (?, ?, ?, 2, 1, ?)",
          missing,
          TESSERACT,
          legacyBody.length,
          legacyBody,
        );
      }
      sql.exec(
        "INSERT INTO texts (hash, engine, bytes, words, at) VALUES (?, ?, ?, 2, 1)",
        legacy,
        TESSERACT,
        legacyBody.length,
      );
    });

    expect(await listing(board, token)).toEqual({
      failed: [],
      reading: [],
      recoveryDelay: 0,
      stored: [{ engine: TESSERACT, hash }],
    });
    await expect
      .poll(() => listing(board, token))
      .toMatchObject({
        recoveryDelay: expect.any(Number),
        stored: expect.arrayContaining([
          { engine: TESSERACT, hash },
          { engine: TESSERACT, hash: legacy },
        ]),
      });
    await runInDurableObject(room, (_instance, { storage: { sql } }) => {
      expect(
        sql.exec("SELECT count(*) AS count FROM texts WHERE ready = 0 AND retry_after > 0").one(),
      ).toEqual({ count: interrupted.length });
    });
    expect((await call(`/rooms/${board}/files/${hash}/text/${TESSERACT}`, token)).status).toBe(200);
  });

  it("drains an active OCR recovery before clearing and reopening a hosted room", async () => {
    const board = "destroy-during-recovery";
    const token = await pass({ board });
    const hash = await upload(board, token, PNG);
    const key = textKey(board, hash, TESSERACT);
    const body = JSON.stringify(result(hash, TESSERACT));
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));

    await runInDurableObject(room, async (instance) => {
      const admitted: Pass = {
        avatar: null,
        board,
        link: 0,
        name: "Ania",
        owner: false,
        role: "write",
        sub: "u:1",
      };
      const texts = Reflect.get(instance, "texts") as TextLedger;
      const files = Reflect.get(instance, "files") as FileLedger;
      const wipe = files.wipe.bind(files);
      let recovered = false;
      let release = () => {};
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(texts, "recover").mockImplementationOnce(async () => {
        await paused;
        await hostedEnv.Files.put(key, body);
        recovered = true;
      });
      vi.spyOn(files, "wipe").mockImplementationOnce((name) => {
        expect(recovered).toBe(true);
        return wipe(name);
      });

      const recovery = instance.recoverTexts(admitted);
      const deletion = instance.destroy(board);
      const duringDeletion = instance.textListing(admitted);
      release();
      await Promise.all([recovery, deletion]);
      expect(duringDeletion).toBe("link-reset");
    });

    expect(await hostedEnv.Files.head(key)).toBeNull();
    expect((await listing(board, token)).stored).toEqual([]);
    expect(await upload(board, token, PNG)).toBe(hash);
  });

  it("adopts a legacy R2 reading whose ledger reservation was lost", async () => {
    const board = "legacy-r2-reading";
    const token = await pass({ board });
    const hash = await upload(board, token, PNG);
    const first = { ...result(hash, TESSERACT), createdAt: new Date(1000).toISOString() };
    const key = textKey(board, hash, TESSERACT);
    const body = JSON.stringify(first);
    await hostedEnv.Files.put(key, body, { httpMetadata: { contentType: "application/json" } });

    const retried = await put(board, token, hash, TESSERACT, result(hash, TESSERACT, ["New"]));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(first);
    expect(await (await hostedEnv.Files.get(key))!.text()).toEqual(body);
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));
    await runInDurableObject(room, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT bytes, words FROM texts").toArray()).toEqual([
        { bytes: new TextEncoder().encode(body).byteLength, words: 2 },
      ]);
    });
  });

  it("keeps a reading per engine, side by side", async () => {
    const token = await pass({ board: "both" });
    const hash = await upload("both", token, JPEG);
    expect((await put("both", token, hash, PPOCR, result(hash, PPOCR))).status).toBe(201);
    expect((await put("both", token, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(201);
    const listed = (await listing("both", token)) as { stored: unknown[] };
    expect(listed.stored).toHaveLength(2);
  });

  it("refuses a stranger, another board's pass and a reader without one", async () => {
    const token = await pass({ board: "mine" });
    const hash = await upload("mine", token, PNG);
    const theirs = await pass({ board: "theirs" });
    expect((await put("mine", theirs, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(403);
    expect((await put("mine", null, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(403);
    expect((await call(`/rooms/mine/files/text`, theirs)).status).toBe(403);
    expect((await call(`/rooms/mine/files/${hash}/text/${TESSERACT}`, null)).status).toBe(403);
    expect(
      (await post("mine", theirs, "claim", { candidates: [hash], engines: [TESSERACT] })).status,
    ).toBe(403);
  });

  it("refuses a reading of an image the board does not have, or of an engine it does not know", async () => {
    const token = await pass({ board: "unknown" });
    const hash = await upload("unknown", token, PNG);
    const stranger = "c".repeat(64);
    const missing = await put("unknown", token, stranger, TESSERACT, result(stranger, TESSERACT));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown-image" });
    expect((await put("unknown", token, hash, "vision-1", result(hash, TESSERACT))).status).toBe(
      404,
    );
  });

  it("checks what it is told against the stored image", async () => {
    const token = await pass({ board: "checked" });
    const hash = await upload("checked", token, PNG);
    const wrongSize = {
      ...result(hash, TESSERACT),
      image: { height: 21, sha256: hash, width: 38 },
    };
    const refused = await put("checked", token, hash, TESSERACT, wrongSize);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "invalid", problem: "image size" });
    const otherEngine = await put("checked", token, hash, TESSERACT, result(hash, PPOCR));
    expect(await otherEngine.json()).toEqual({ error: "invalid", problem: "engine" });
    expect((await put("checked", token, hash, TESSERACT, "{not json")).status).toBe(422);
    const huge = await put("checked", token, hash, TESSERACT, "x".repeat(600 * 1024));
    expect(huge.status).toBe(413);
    expect((await put("checked", token, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(
      201,
    );
  });

  it("does not read text off an SVG", async () => {
    const token = await pass({ board: "vector" });
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="37" height="21"/>',
    );
    const hash = await upload("vector", token, svg);
    expect((await put("vector", token, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(422);
    const claimed = await post("vector", token, "claim", {
      candidates: [hash],
      engines: [TESSERACT],
    });
    expect(claimed.status).toBe(204);
  });

  it("lets one person store so many readings a minute", async () => {
    const token = await pass({ board: "flood" });
    const hash = await upload("flood", token, PNG);
    const wrong = { ...result(hash, TESSERACT), format: "nope" };
    for (let sent = 0; sent < MAX_TEXT_WRITES_PER_MINUTE; sent++) {
      expect((await put("flood", token, hash, TESSERACT, wrong)).status).toBe(422);
    }
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName("flood"));
    await evictDurableObject(room);
    expect((await put("flood", token, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(429);
    const other = await pass({ board: "flood", sub: "u:2" });
    expect((await put("flood", other, hash, TESSERACT, result(hash, TESSERACT))).status).toBe(201);
  });

  it("counts readings against the board's storage", async () => {
    const token = await pass({ board: "full" });
    const hash = await upload("full", token, PNG);
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName("full"));
    await runInDurableObject(room, async (_instance, state) => {
      const ledger = new TextLedger(state.storage.sql, hostedEnv.Files);
      const body = new TextEncoder().encode(JSON.stringify(result(hash, TESSERACT))).buffer;
      const job = { board: "full", engine: TESSERACT, hash, sub: "u:1" };
      expect(await ledger.store(job, body, { bytesNow: () => MAX_BOARD_FILE_BYTES - 10 })).toBe(
        "over-quota",
      );
      expect(await ledger.store(job, body, { bytesNow: () => 0 })).toMatchObject({
        duplicate: false,
      });
    });
  });

  it("tells everyone on the board once a reading is stored", async () => {
    const token = await pass({ board: "told" });
    const hash = await upload("told", token, PNG);
    const watcher = await seat("told", await pass({ board: "told", sub: "u:2" }));
    await put("told", token, hash, TESSERACT, result(hash, TESSERACT));
    await until(() => watcher.received.some((message) => message.type === "custom"));
    const custom = watcher.received.find((message) => message.type === "custom");
    expect(custom?.data).toEqual({
      readings: [{ engine: TESSERACT, hash }],
      state: "stored",
      type: "image-text",
    });
  });

  it("is deleted with the board", async () => {
    const token = await pass({ board: "gone" });
    const hash = await upload("gone", token, PNG);
    await put("gone", token, hash, TESSERACT, result(hash, TESSERACT));
    expect((await destroy("gone", await deletion({ board: "gone" }))).status).toBe(204);
    const left = await hostedEnv.Files.list({ prefix: boardPrefix("gone") });
    expect(left.objects).toEqual([]);
    const fresh = await pass({ board: "gone" });
    expect(await listing("gone", fresh)).toEqual({ failed: [], reading: [], stored: [] });
  });
});

describe("handing out images to read", () => {
  type Claimed = { engines: EngineKey[]; hash: string; lease: string };

  const claim = async (board: string, token: string, body: object): Promise<Claimed | null> => {
    const response = await post(board, token, "claim", body);
    if (response.status === 204) return null;
    expect(response.status).toBe(200);
    return response.json();
  };

  it("keeps a reader's claim when the room hibernates", async () => {
    const board = "sleeping-reader";
    const ada = await pass({ board });
    const bea = await pass({ board, sub: "u:2" });
    const hash = await upload(board, ada, PNG);
    const request = { candidates: [hash], engines: [TESSERACT] };
    const held = await claim(board, ada, request);
    expect(held).toMatchObject({ hash });

    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName(board));
    await evictDurableObject(room);
    expect(await claim(board, bea, request)).toBeNull();
    expect((await post(board, ada, "renew", { lease: held!.lease })).status).toBe(204);
    expect(await listing(board, bea)).toMatchObject({ reading: [{ engine: TESSERACT, hash }] });
    expect((await post(board, ada, "release", { failed: [], lease: held!.lease })).status).toBe(
      204,
    );
    expect(await claim(board, bea, request)).toMatchObject({ hash });
  });

  it("gives two browsers two different images, the one asked for first", async () => {
    const ada = await pass({ board: "two" });
    const bea = await pass({ board: "two", sub: "u:2" });
    const png = await upload("two", ada, PNG);
    const jpeg = await upload("two", ada, JPEG);
    const engines = [TESSERACT, PPOCR];

    const first = await claim("two", ada, { candidates: [png, jpeg], engines, prefer: jpeg });
    expect(first).toMatchObject({ engines, hash: jpeg });
    const second = await claim("two", bea, { candidates: [png, jpeg], engines });
    expect(second).toMatchObject({ engines, hash: png });
    expect(await claim("two", bea, { candidates: [png, jpeg], engines })).toBeNull();

    const listed = (await listing("two", bea)) as { reading: unknown[] };
    expect(listed.reading).toHaveLength(4);
  });

  it("hands out only the engines an image still lacks", async () => {
    const ada = await pass({ board: "lacks" });
    const hash = await upload("lacks", ada, PNG);
    await put("lacks", ada, hash, TESSERACT, result(hash, TESSERACT));
    expect(
      await claim("lacks", ada, { candidates: [hash], engines: [TESSERACT, PPOCR] }),
    ).toMatchObject({
      engines: [PPOCR],
    });
  });

  it("gives an image to another browser once a lease runs out, and not before a renewal does", async () => {
    const ada = await pass({ board: "lease" });
    const bea = await pass({ board: "lease", sub: "u:2" });
    const hash = await upload("lease", ada, PNG);
    const room = hostedEnv.BoardRoom.get(hostedEnv.BoardRoom.idFromName("lease"));
    await runInDurableObject(room, (_instance, state) => {
      const ledger = new TextLedger(state.storage.sql, hostedEnv.Files);
      const request = { candidates: [hash], engines: [TESSERACT], prefer: null };
      const held = ledger.claim("u:1", request, 1000);
      expect(held).toMatchObject({ hash });
      expect(ledger.claim("u:2", request, 1000 + TEXT_LEASE_MS - 1)).toBeNull();
      expect(ledger.renew("u:1", (held as Claimed).lease, 1000 + TEXT_LEASE_MS - 1)).toBe(true);
      expect(ledger.claim("u:2", request, 1000 + TEXT_LEASE_MS + 1)).toBeNull();
      expect(ledger.renew("u:2", (held as Claimed).lease, 1000 + TEXT_LEASE_MS + 1)).toBe(false);
      expect(ledger.claim("u:2", request, 1000 + 2 * TEXT_LEASE_MS)).toMatchObject({ hash });
      expect(ledger.renew("u:1", (held as Claimed).lease, 1000 + 2 * TEXT_LEASE_MS)).toBe(false);
    });
    expect((await post("lease", bea, "renew", { lease: "nobody" })).status).toBe(409);
  });

  it("stops handing out an image that failed too often for an engine", async () => {
    const ada = await pass({ board: "fails" });
    const hash = await upload("fails", ada, PNG);
    const body = { candidates: [hash], engines: [TESSERACT, PPOCR] };
    for (let failure = 0; failure < MAX_TEXT_FAILURES; failure++) {
      const held = await claim("fails", ada, body);
      expect(held?.engines).toContain(TESSERACT);
      expect(
        (await post("fails", ada, "release", { failed: [TESSERACT], lease: held!.lease })).status,
      ).toBe(204);
    }
    expect(await claim("fails", ada, body)).toMatchObject({ engines: [PPOCR] });
    expect(await listing("fails", ada)).toMatchObject({ failed: [{ engine: TESSERACT, hash }] });
  });

  it("refuses a claim it cannot read", async () => {
    const ada = await pass({ board: "bad-claim" });
    expect(
      (await post("bad-claim", ada, "claim", { candidates: ["../x"], engines: [TESSERACT] }))
        .status,
    ).toBe(400);
    expect(
      (await post("bad-claim", ada, "claim", { candidates: [], engines: ["vision-1"] })).status,
    ).toBe(400);
  });
});
