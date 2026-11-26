import assert from "node:assert/strict";
import test from "node:test";

import { propose, submission } from "./gizmo-submission.mjs";

const manifest = "https://github.com/alice/cards/blob/" + "a".repeat(40) + "/tarot/gizmo.json";
const source = submission(manifest);
const name = { en: "Tarot", pl: "Tarot" };
const review = "https://github.com/example/table/pull/9";

test("only canonical public GitHub manifest permalinks can become registry proposals", () => {
  for (const url of [
    manifest.replace("github.com", "example.org"),
    manifest.replace("a".repeat(40), "main"),
    manifest.replace("/tarot/", "/../"),
    manifest + "?ref=other",
    manifest.replace("gizmo.json", "index.js"),
  ])
    assert.throws(() => submission(url));
  const next = submission(manifest.replace("a".repeat(40), "b".repeat(40)));
  assert.equal(source.record, next.record);
  assert.notEqual(source.key, next.key);
});

test("a closed review blocks the same revision without any writes or package reads", async () => {
  const result = await propose({
    repository: "example/table",
    base: "main",
    source,
    names: () => assert.fail("Read manifest after review"),
    api: async (route, options) => {
      assert.equal(options, undefined);
      assert.match(route, /state=all/u);
      return [{ state: "closed", html_url: review }];
    },
  });
  assert.equal(result, review);
});

test("the PR changes one JSON entry and points the reviewer to the pinned source", async () => {
  const writes = [];
  const sha = "b".repeat(40);
  const result = await propose({
    repository: "example/table",
    base: "main",
    source,
    issue: "12",
    names: async () => name,
    api: async (route, options) => {
      if (options?.method === "POST") {
        writes.push({ route, body: options.body });
        if (route === "graphql")
          return { data: { createCommitOnBranch: { commit: { oid: sha } } } };
        if (route.endsWith("/pulls")) return { html_url: review };
        return {};
      }
      if (route.includes("/pulls?")) return [];
      if (route.endsWith("/heads/main")) return { object: { sha } };
      if (route.includes("contents/gizmos/registry.json?"))
        return { content: Buffer.from("[]").toString("base64") };
      if (options?.missing) return null;
      assert.fail(route);
    },
  });
  assert.equal(result, review);
  const [ref, commit, pr] = writes;
  assert.equal(ref.body.sha, sha);
  const { expectedHeadOid, fileChanges } = commit.body.variables.input;
  assert.equal(expectedHeadOid, sha);
  assert.deepEqual(
    fileChanges.additions.map((file) => file.path),
    [source.record],
  );
  assert.deepEqual(JSON.parse(Buffer.from(fileChanges.additions[0].contents, "base64")), {
    name,
    thumbnail: "/icon-192.png",
    url: manifest,
  });
  assert.equal(pr.body.base, "main");
  assert.ok(pr.body.body.includes(manifest));
  assert.ok(pr.body.body.includes("Closes #12"));
});

test("registry entries pin one revision per Gizmo and use checked-in marketplace thumbnails", async () => {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const root = new URL("../../", import.meta.url);
  const read = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
  const entries = await read("gizmos/registry.json");
  const directory = new URL("gizmos/registry/", root);
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const entry = await read("gizmos/registry/" + file);
    assert.equal(submission(entry.url).record, "gizmos/registry/" + file);
    entries.push(entry);
  }
  const packages = new Set();
  for (const entry of entries) {
    const { identity } = submission(entry.url);
    assert.ok(!packages.has(identity), "Duplicate listing: " + identity);
    packages.add(identity);
    for (const lang of ["en", "pl"]) assert.ok(entry.name[lang]?.trim());
    assert.match(
      entry.thumbnail,
      /^\/(?:icon-192\.png|gizmos\/(?:[\w-]+\/)+[\w-]+\.(?:webp|png|jpg|jpeg))$/u,
    );
    const local = entry.thumbnail.slice(1);
    const asset = new URL(local.startsWith("gizmos/") ? local : "client/public/" + local, root);
    assert.ok((await stat(asset)).size > 0);
  }
});
