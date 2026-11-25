import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const author = { id: "mira", mode: "mcp", generation: 1 };
const board = { id: "duet", owner: "ash", revision: 0, installed: null };
const draft = { id: "tracker", revision: 1, rule: "add 1" };
const releases = new Map();

function authorizeWriter(writer) {
  assert.equal(writer.author, author.id, "different author");
  assert.equal(writer.draft, draft.id, "different draft");
  assert.equal(writer.mode, author.mode, "inactive authoring path");
  assert.equal(writer.generation, author.generation, "expired write grant");
}

function changeRule(writer, expectedRevision, rule) {
  authorizeWriter(writer);
  assert.equal(expectedRevision, draft.revision, "stale draft");
  draft.rule = rule;
  draft.revision += 1;
}

function digest() {
  const manifest = JSON.stringify({ widget: "spotlight", rule: draft.rule });
  return createHash("sha256").update(manifest).digest("hex");
}

function publish(writer, consent, audience) {
  authorizeWriter(writer);
  assert.equal(consent.author, author.id, "different consenting author");
  assert.equal(consent.generation, author.generation, "expired release consent");
  assert.equal(consent.digest, digest(), "changed package");
  assert.equal(consent.audience, audience, "changed audience");
  releases.set(consent.digest, draft.rule);
  return consent.digest;
}

function install(actor, review, candidate) {
  assert.equal(actor, board.owner, "owner required");
  assert.equal(review.owner, actor, "different reviewing owner");
  assert.equal(review.board, board.id, "different board");
  assert.equal(review.base, board.revision, "stale install review");
  assert.equal(review.digest, candidate, "different release");
  assert.ok(releases.has(candidate), "missing release");
  board.installed = candidate;
  board.revision += 1;
}

const mcp = { author: author.id, draft: draft.id, mode: "mcp", generation: 1 };
const confirm = () => ({
  author: author.id,
  generation: author.generation,
  digest: digest(),
  audience: "unlisted",
});
const review = (release) => ({
  owner: board.owner,
  board: board.id,
  base: board.revision,
  digest: release,
});

const initialConsent = confirm();
const original = publish(mcp, initialConsent, "unlisted");
const originalReview = review(original);
assert.throws(() => publish(mcp, initialConsent, "public"), /changed audience/);
assert.throws(
  () => changeRule({ ...mcp, author: "another player" }, 1, "add 3"),
  /different author/,
);

author.mode = "workshop";
author.generation += 1;
const workshop = { ...mcp, mode: author.mode, generation: author.generation };
assert.throws(() => changeRule(mcp, 1, "add 3"), /inactive authoring path/);
assert.throws(() => publish(workshop, initialConsent, "unlisted"), /expired release consent/);
const beforeEdit = confirm();
changeRule(workshop, 1, "add 3");
assert.throws(() => publish(workshop, beforeEdit, "unlisted"), /changed package/);
const revisedConsent = confirm();
const revised = publish(workshop, revisedConsent, "unlisted");
assert.equal(publish(workshop, revisedConsent, "unlisted"), revised);
assert.equal(releases.size, 2);

author.mode = "mcp";
author.generation += 1;
assert.throws(() => changeRule(mcp, 2, "add 2"), /expired write grant/);
assert.equal(draft.rule, "add 3");
process.stdout.write("Both paths can publish. An old grant stays revoked after switching back.\n");

const revisedReview = review(revised);
assert.throws(() => install("mira", originalReview, original), /owner required/);
assert.throws(() => install("ash", originalReview, revised), /different release/);
assert.equal(board.revision, 0);
install("ash", originalReview, original);
assert.throws(() => install("ash", revisedReview, revised), /stale install review/);
assert.equal(board.installed, original);
install("ash", review(revised), revised);
assert.equal(board.installed, revised);
process.stdout.write(
  "An owner installs the reviewed edition. A stale update needs a fresh review.\n",
);
