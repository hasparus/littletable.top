# Assistants on the board: the MCP server and the server-side ops engine

Status: design and spike, branch `mcp`. What is built is marked **built**;
everything else is a plan. Numbers were measured on this branch (tldraw
5.6.0, workerd from wrangler 4.145, Node 26 for timings) unless a source is
named.

## Decisions on record

Made by the maintainer; later sections follow them.

1. **The adapted tldraw code ships.** tldraw's answer was "generally yeah",
   "adapt the code"; no written confirmation is being waited for. The
   provenance document, the per-file origin headers and the separate
   `upstream/` folders stay.
2. **The role is "manager"** (Polish "opiekun tablicy"). A board has people who can
   write, and managers. Only a manager connects an assistant to a board and
   chooses read or edit. The owner makes managers on a permissions page.
   Built: §9b.
3. **Recent changes list people and assistants**, a summary per actor and
   time, 200 entries or 30 days, with undo for an assistant's batch.
4. **Standalone consent: WorkOS, then our own board step** (§9).
5. **The tabletop owns board names, in hosted mode too**; `create_board`
   and `rename_board` exist in both modes (§9c).
6. **`mcp.<domain>`** is the MCP host; **screenshots** come from
   Cloudflare's headless browser, with a connected tab as the fast path.
7. MCP in a second Worker; tldraw's engine adapted, not rewritten.

## 0. Where this stands (latest)

The branch is merged with `main` (multi-page, images, avatars, search,
dice, the rename): see §14. The role model is built in the board Worker,
the room and the standalone front page.

## 0. Where this stands (latest)

tldraw allowed us to adapt its hosted-app code, so the engine is no longer
ours: **tldraw's own canvas-ops engine runs in the MCP Worker, unchanged but
for its import line, on a stand-in for tldraw's `Editor`** built from the
records snapshot, our geometry and our text measurer. All eleven operations
work offline; tldraw's 38 engine tests pass on the stand-in; and on four
realistic boards the stand-in and a real browser editor, given the same
batch, write the same records. Sections 1 to 4 describe what the stand-in
stands on and are still current; §5 and §6 (our own ops and clustering) are
superseded and kept short.

### Inventory: what tldraw's code asks an editor for

Counted from the source at `ebe1433` (`ops.ts`, `actions.ts`, `receiver.ts`;
`pathGeometry.ts` and `schema.ts` call no editor).

| Call                                                                                                                                                                   | Uses      | Class            | How the stand-in answers                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor.getShape`                                                                                                                                                      | 23        | already covered  | The document view (`Doc`); a lookup by id is also what records the batch's dependencies for the conflict check                                                                                                                                                      |
| `editor.createShape`                                                                                                                                                   | 6         | needed real work | What `Editor.createShapes` does to a record: default props per type, the topmost frame under the point as parent, top index, the page's 4,000-shape limit, then the shape util's `onBeforeCreate` (geo `growY`, note `growY` and font adjustment) from our measurer |
| `editor.getShapePageBounds`                                                                                                                                            | 5         | already covered  | Our geometry                                                                                                                                                                                                                                                        |
| `editor.getShapeUtil(shape).getText`                                                                                                                                   | 4         | easy             | Plain text of the rich text; a frame's name                                                                                                                                                                                                                         |
| `editor.getShapeGeometry`                                                                                                                                              | 3         | needed real work | `.bounds` from our geometry; `hitTestPoint` on a geo outline as a polygon or ellipse (`geo-outline.ts`; hearts, clouds and stars are taken as the ellipse in their box)                                                                                             |
| `editor.markHistoryStoppingPoint` / `bailToMark` / `squashToMark`                                                                                                      | 2 / 1 / 1 | already covered  | Marks and rollback on the document view's journal; the batch is one commit, so squashing is a no-op                                                                                                                                                                 |
| `editor.getShapePageTransform`                                                                                                                                         | 2         | already covered  | Our transforms (`applyToPoint`, `rotation()`)                                                                                                                                                                                                                       |
| `editor.updateShape`                                                                                                                                                   | 1         | needed real work | Merge as the editor does, skip locked shapes, then `onBeforeUpdate` of geo (grow or widen to the label, the first-label rule), note and text (auto-size shift by alignment)                                                                                         |
| `editor.deleteShapes`                                                                                                                                                  | 1         | easy             | Descendants and bindings go; an arrow that outlives a bound shape keeps its drawn end, as the arrow binding util does                                                                                                                                               |
| `editor.createBindings`                                                                                                                                                | 1         | already covered  | Binding records, then the arrow binding util's re-parenting and order rule                                                                                                                                                                                          |
| `editor.resizeShape`                                                                                                                                                   | 1         | needed real work | Only the case the engine uses: lines (points scaled) and strokes (`scaleX`/`scaleY`), about a page point, on shapes turned by quarter turns or scaled evenly                                                                                                        |
| `editor.textMeasure.measureText`                                                                                                                                       | 1         | already covered  | fontkit measurer (§3)                                                                                                                                                                                                                                               |
| `getArrowInfo(editor, arrow)`                                                                                                                                          | 1         | needed real work | Drawn ends of straight arrows as tldraw clips them (10 px gap plus strokes at an arrowhead, the short-arrow rule); see the limits below                                                                                                                             |
| `editor.run`, `getCurrentPageId`, `getCurrentPageShapes(Sorted)`, `getSelectedShapeIds`, `getShapeAndDescendantIds`, `isShapeOrAncestorLocked`, `getBindingsFromShape` | 1 each    | easy             | From records                                                                                                                                                                                                                                                        |
| `createShapeId`, `createBindingId`, `toRichText`, `b64Vecs`, `DefaultFontFamilies`, `getIndices`, `uniqueId`, `structuredClone`                                        | -         | already covered  | tldraw's MIT packages                                                                                                                                                                                                                                               |
| `areAnglesCompatible`                                                                                                                                                  | 1         | easy             | Five lines                                                                                                                                                                                                                                                          |

The page-read code (`shapeClusters.ts`, `mcpPageRead.ts`) calls no editor
at all: it takes shapes, bindings and per-shape measurements. Upstream
fills those in a browser tab (`boardCapture.ts`: `getShape`,
`getShapePageBounds`, `getShapeUtil().getText`, `getShapePageTransform`,
`getShapeGeometry`, `getArrowInfo`); `src/mcp/page-read.ts` fills them
from records.

**Nothing the engine or the page-read code calls needs a DOM.** The only
DOM-bound call in the whole path is `editor.toImage`, for screenshots (§7).
`{selected: true}` needs a person's live selection, which is presence, not
DOM; with nobody connected the engine answers "The user has nothing
selected", and reading it from the acting account's session is planned.

### How small the adaptation is

|                                                                                                                     | Lines             | Changed against upstream                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| Engine: `ops.ts`, `actions.ts`, `schema.ts`, `pathGeometry.ts`, `receiver.ts`                                       | 2,301             | 16 (five import lines, and one added 8-line export for run memory)                  |
| Clustering and page read: `shapeClusters.ts`, `mcpPageRead.ts`; the ops JSON schema                                 | 1,913             | 0                                                                                   |
| Tool layer: `boardTools.ts`                                                                                         | 907 of 2,668 kept | An excerpt; wording changed only where it named tldraw.com or asked for an open tab |
| tldraw's engine tests: `ops.test.ts`                                                                                | 841               | 73: imports and the editor factory                                                  |
| Ours: the stand-in (`src/mcp/editor/`, 880 lines) and the glue (`board.ts`, `page-read.ts`, `server.ts`, 500 lines) |                   |                                                                                     |

Every file and change is in `docs/upstream-provenance.md`. Our own engine,
placement, routing, schema and clustering were deleted.

### tldraw's own tests on the stand-in

All 38 tests of upstream's `ops.test.ts` pass (`test/mcp/upstream`, in
workerd), with upstream's fixed-width measurer swapped in as upstream does.
One failed on the first run: "resizes a rotated line along the page axes it
was measured in". That was a real gap in the stand-in (`resizeShape` took
the page-axis scale as the shape's own on a shape a quarter turn round),
now fixed. None fails on a DOM assumption. Two tests use `editor.undo()`
and `redo()`; the stand-in implements them as "take back the last batch",
which is also the seed of undo-a-batch (§9b).

### Fidelity against the real editor

`e2e/measure/fidelity.spec.ts` (`aube run e2e:fidelity`): each scenario's
page is set up through a real tldraw editor in Chromium; the batch is run
there by the adapted engine with its `tldraw` import pointed back at the
real package, and again in Node on the stand-in from the same starting
records; the two sets of records are compared field by field.

| Scenario                                                                                                                                                     | Ops | Shapes after | Fields that differ | Largest difference         | Order, bindings, per-op results |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------------ | ------------------ | -------------------------- | ------------------------------- |
| Relationship map: boxes, ellipse, diamond, a note in Polish, four labelled arrows, labels, rename with widen, restyle                                        | 13  | 14           | 0                  | 0.005 px (x), 0.007 px (w) | same                            |
| Crowded page: 24 overlapping boxes; untangle, place, add beside, duplicate, resize, remove                                                                   | 8   | 25           | 0                  | 0                          | same                            |
| Frames and a group: add inside a frame, beside a framed box, connect out of the frame and within it, place a grouped shape, label, rename the frame, restyle | 8   | 11           | 0                  | 0.004 px                   | same                            |
| Rotated shapes: add beside and label a tilted box, connect to a turned one, resize it, an open path resized, a closed smooth path, place                     | 8   | 8            | 0                  | 0.004 px                   | same                            |

Multi-page is covered by the run itself: each scenario is a page of one
document, so the stand-in always computes with other pages' shapes present.
Compared: position, rotation, parent, type, every prop (sizes, `growY`,
bend, arrow ends, text, styles), z-order, and each binding's ends, anchor
and flags. A difference counts above 0.5 px; the residue is fontkit against
HarfBuzz on text widths.

Getting there took one correction: tldraw lets an arrow that would be
shorter than its minimum reach into the shape it points at, which moved
arrow labels by 7 px and, through a collision that then did or did not
happen, another label by 24. With that rule in `arrowPath` the records are
identical.

Screenshots, browser and stand-in side by side:
`screenshots/board/ops2-{map,crowded,frames,rotated}-{browser,standin}.png`.
The map pair is indistinguishable. The frames pair is identical too, and
shows the engine's own limits, in the browser as well: an arrow drawn
through a box inside the frame, and a label lying on a box.

### Costs

|                                             | Raw        | gzip       |
| ------------------------------------------- | ---------- | ---------- |
| Board Worker (unchanged by this step)       | 608.1 KiB  | 123.6 KiB  |
| MCP Worker before the adapted code          | 2990.5 KiB | 1099.2 KiB |
| MCP Worker with it (our own engine removed) | 3128.4 KiB | 1127.3 KiB |

Timings, Node (same V8), a board of 5,000 shapes on two pages (2,500 each;
tldraw allows 4,000 shapes a page and the stand-in keeps that limit) plus
490 arrows, 6,472 records, 3.4 MB:

| Step                                                                    | Time                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 500 `add`s in one batch, on an empty page / on 2,000 shapes             | 0.44 s / 0.89 s                                                     |
| 490 `connect`s in one batch on the full page                            | 3.1 s                                                               |
| One `add` beside a target, cold / warm                                  | 25 ms / 10 ms                                                       |
| `untangle` of 10 shapes on the full page                                | 49 ms                                                               |
| `untangle` of a pile of 100 overlapping boxes                           | 370 ms (moved 12; the engine reports the rest as "could not clear") |
| `get_page_info` on a 2,500-shape page: measure and cluster, cold / warm | 71 ms / 41 ms; shaping the 40K-character answer 2 ms                |
| `get_cluster_info` for three clusters                                   | 36 ms                                                               |
| `search_shapes` over both pages                                         | 5 ms                                                                |

Nothing here comes near the 30 s CPU limit. What could: a batch of 1,000
`connect`s on a crowded page (the engine scans every shape per op: about
6 ms each at 2,500 shapes, so about 6 s), and memory for very large
boards, since a call holds the snapshot, the document view and the diff
(roughly three times the snapshot's 3.4 MB here, against 128 MB).

### What does not work yet

- `{selected: true}` with nobody connected, by design; reading it from the
  acting account's session is not built.
- Arrow geometry beyond straight arrows cut at a shape's box: curved and
  elbow arrows, and exact outlines of ellipses and diamonds, are
  approximated. It matters only for where the engine puts arrow labels; no
  scenario above hit it, and one built to hit it would differ by a few px.
- `hitTestPoint` for hearts, clouds and stars is the ellipse in their box.
- `resizeShape` covers lines and strokes only (all the engine asks for).
- Glyphs outside tldraw's fonts (CJK, emoji) are still estimated (§3), and
  the op result does not yet say so.
- tldraw's page limit of 4,000 shapes is enforced; the board client's own
  options should be checked against it when merging.
- The tools not adapted: screenshots, user state and board users, create
  and rename board. Unexpected errors inside a tool come back as their
  message, not yet as upstream's closed vocabulary.
- Standalone mode still has no MCP Worker: its tokens come from WorkOS
  (§9), which the MCP Worker does not verify yet, and the Alchemy helper
  deploys the MCP Worker for hosted mode only.

## 1. Decision (the server-side engine)

**Go: a pure, server-side operations engine, in a Worker of its own.** The
MCP Worker reads a snapshot of the board's records from the board's Durable
Object, computes with our own geometry and text measurer, and commits a
diff; the room validates it, checks that nothing it rested on has changed,
writes one storage transaction, and the sync room sends that to connected
browsers as one patch. No browser tab is involved, so a board nobody has
open behaves exactly like an open one. Upstream's hosted tools relay to
the user's tab and refuse without one; we do not copy that architecture.

The first version of this spike ran the engine inside the Durable Object
and I wrote that it had to stay there. That was wrong: what has to stay in
the room is the atomic check-and-write, not the computing. §1a is the
split the maintainer asked for, built and measured.

The risky part was text. It is solved to the pixel for tldraw's own fonts
(§3): 100% of line counts, heights, geo `growY`, note `growY` and note font
adjustments match Chrome for Latin and Polish text in all four families and
four sizes; widths are within 1.6 px. What a server cannot know is the
reader's system fallback font for glyphs tldraw's fonts lack (CJK, emoji);
those are estimated and flagged.

What runs where:

| Concern                                                     | Where                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| Sync rooms, dice, images, accounts: everything players load | The board Worker (`src/index.ts`, `BoardRoom`)               |
| Snapshot, check-and-commit, run memory, grant version       | `BoardRoom`, through `src/room-document.ts` (196 lines)      |
| MCP transport, token check, tool schemas                    | The MCP Worker (`src/mcp/worker.ts`), stateless              |
| Ops engine, text measurer and fonts, clustering             | The MCP Worker (`src/ops/`)                                  |
| Delivery to open tabs                                       | tldraw sync, unchanged                                       |
| Screenshots, search (later)                                 | The MCP Worker; Browser Run for pictures (§7)                |
| Selection and viewport (`get_user_state`)                   | Presence of the account's own session, read through the room |

## 1a. Two Workers

### The split

```
assistant ──HTTPS──▶ MCP Worker (tabletop-mcp)                board Worker (tabletop)
                     token, MCP SDK, engine, fonts            routes, sync, dice, images
                        │  Durable Object binding               │
                        │  (class BoardRoom, script tabletop)   │
                        └──── readDocument / commitDocument ───▶ BoardRoom ◀──sync── browsers
```

The dependency runs one way: the MCP Worker binds to the board Worker's
`BoardRoom` class by script name and calls its RPC methods. The board
Worker does not know the MCP Worker exists and deploys without it.

| Bundle                                    | Raw           | gzip          | Startup (local, median of 5) |
| ----------------------------------------- | ------------- | ------------- | ---------------------------- |
| Board Worker before the spike (`f6896cf`) | 602.0 KiB     | 122.0 KiB     | 122 ms                       |
| One Worker with the spike (`87c6020`)     | 3206.8 KiB    | 1151.6 KiB    | 494 ms                       |
| **Board Worker after the split**          | **608.1 KiB** | **123.6 KiB** | 159 ms                       |
| MCP Worker after the split                | 2990.5 KiB    | 1099.2 KiB    | 107 ms                       |

The board Worker gained 6.1 KiB raw, 1.5 KiB gzip: `src/room-document.ts`
and 70 lines in `src/board-room.ts`; `src/index.ts` and `src/config.ts`
are as they were before the spike. Startup is from `wrangler check
startup` (a CPU profile of module evaluation in local workerd; runs ranged
89-204 ms for the small bundles, so 122 and 159 are the same within noise).
The single-Worker build took 364-554 ms, against a platform limit that is
of that order, which alone justifies the split. Why the MCP Worker by
itself evaluates faster than the combined build was not investigated.

### The room's document interface (the contract)

RPC methods on `BoardRoom`, callable only by a Worker bound to the class.
There is no HTTP route. Types in `src/room-document.ts`, shared by a
type-only import (`RoomDocumentCalls` is written out by hand because the
stub's inferred types recurse through every tldraw record type until
TypeScript gives up).

```ts
readDocument(grant, { scope: "document" | { page }, runId? })
  → { clock, records, created } | "revoked"

commitDocument(grant, { since, puts, removes, unchanged, absent, run? })
  → { kind: "committed", clock }
  | { kind: "conflict", why: "changed" | "exists" | "referenced" | "stale", records }
  | { kind: "invalid", message }
  | "read-only" | "revoked"

revokeMcpGrants(board, version)
```

- `grant` is the board's entry from a token the caller verified
  (`{board, access, grant, title}`). The room refuses a grant version below
  its own and a write under read access. It trusts the caller for the
  signature: only our own Workers can hold the binding.
- `readDocument` returns records and the document clock from one storage
  transaction. A page scope returns every page record, that page's shapes
  at any depth and their bindings. `created` is the run's memory.
- `commitDocument` validates every put against the tldraw schema, then in
  **one synchronous storage transaction** checks the preconditions and
  writes. A Durable Object runs nothing else in between, so check and write
  are atomic, and the transaction is one patch to browsers.
- The room knows nothing about ops. The same two calls serve the read
  tools, and later screenshots and search.

NOTE: the brief said "through `updateStore`". `TLSocketRoom.updateStore`
is deprecated in sync-core 5.6 in favour of `storage.transaction`, copies
every record with `structuredClone` on each call (54 ms for 8,000 records)
and gives no access to the clock. The room uses `storage.transaction` and
validates with the same record validators `updateStore` uses.

### The conflict model

A whole-document clock check would fail every batch on a busy board.
sync-core stamps each record with the clock of its last change and keeps
tombstones for deletions; `txn.getChangesSince(clock)` returns exactly the
ids put or deleted since a clock. So the check is per record, by version,
with no values compared:

| Precondition                                                                                                   | Sent as                                       | Conflict                |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------- |
| Every record the batch relied on or overwrites is as it was at the snapshot                                    | `unchanged`                                   | `changed`, with the ids |
| Every id the batch creates is still free                                                                       | `absent`                                      | `exists`                |
| Nothing written meanwhile points at a record the batch removes (an arrow bound to it, a child dropped into it) | derived from `removes` by scanning references | `referenced`            |
| The room still has history back to the snapshot's clock                                                        | `since`                                       | `stale`                 |

What a batch "relies on" is tracked by the engine's document view
(`Doc.depend`): every shape an op resolved by reference (id, `{text}`,
`{created}`, the implicit previous shape), with its ancestors, since a
parent's transform moves it; plus the page. Overwritten and removed
records are added from the diff itself.

**Deliberately not a dependency: the neighbours.** Placement and arrow
routing look at every shape on the page as an obstacle. Treating those as
dependencies would be the whole-document check again. If someone drops a
shape into the spot the batch chose while it was computing (tens of
milliseconds), the two overlap, exactly as if they had drawn it a moment
later. Likewise a second shape gaining the same text as a `{text}`
reference just resolved. These are soft; everything that could corrupt the
document or silently undo a person's edit is hard.

On a conflict the MCP Worker reads again and recomputes the whole batch,
at most `MAX_ATTEMPTS = 3` times in all; then it answers "People kept
changing the shapes this batch touches (3 attempts); nothing was applied".
A retry after an `exists` conflict reads the whole document, because an id
taken on another page is invisible in one page's records. Recomputing can
change the outcome, and should: a target that was deleted meanwhile makes
that op fail on its own while the rest apply.

Tests, in the Workers pool with both Workers running
(`test/mcp/concurrency.test.ts`), an edit injected between the snapshot and
the commit:

| Meanwhile                                               | Result                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| An unrelated shape moves                                | applied, 1 attempt; both changes stand                                                           |
| The shape the batch places beside moves                 | conflict, recomputed, 2 attempts; placed beside the new position                                 |
| The shape being renamed is recoloured                   | 2 attempts; the new colour and the new text both stand                                           |
| The target is deleted                                   | 2 attempts; that op reports "No shape on this page has the id inn", the batch's other op applies |
| An arrow is bound to a shape the batch removes          | `referenced` conflict; 2 attempts; the shape and the new binding go, the arrow stays             |
| The target moves on every read                          | "busy" after 3 attempts; nothing applied                                                         |
| A diff naming a taken id; a diff with an invalid record | `exists`; `invalid`; the document is untouched                                                   |

The earlier semantics hold across the two Workers (`test/mcp/apply-ops`,
`test/mcp/mcp`): per-op failure, a schema failure applying nothing, the
offline board, one patch to a connected session, and the Playwright check.

### Cost of the hop

Local miniflare, both Workers in one workerd, a board of 5,003 records on
two pages (`VITE_HOP_COST=1`, `test/mcp/hop-cost.test.ts`):

| Call                                           | Payload (as JSON)      | Time, median (range) |
| ---------------------------------------------- | ---------------------- | -------------------- |
| Read the whole document                        | 5,003 records, 2.79 MB | 97 ms (77-107)       |
| Read one page of two                           | 2,503 records, 1.39 MB | 57 ms (46-83)        |
| Read a page with nothing on it                 | 2 records              | about 45 ms          |
| Commit a 100-record diff                       | 55 KB                  | 8 ms (4-24)          |
| Commit that removes a shape (scans references) | under 1 KB             | 44 ms (28-57)        |

About half of a read is the room decoding its rows (the empty-page read
still costs 45 ms because the page filter runs after everything is
loaded); the other half is moving the records. Production adds real
network between the Worker and the object when they are in different
places. Compared with one `add` computed in 32-99 ms on such a board, the
hop roughly doubles a small call. RPC values are capped at 32 MiB, which
is about 55,000 shapes at this density.

Partial reads: the page scope halves the time when the page is half the
board and is used when the caller names a page id. Worth doing next, in
this order: (1) filter by page in SQL instead of after decoding; (2) keep
the last snapshot per board in the MCP isolate and ask the room only for
`getChangesSince(clock)`, which turns a repeat read into a few KB;
(3) a "pages only" scope for `get_board_info`. None is needed below a few
thousand shapes.

### Binding: Durable Object namespace, not a service entrypoint

|                                              | Durable Object binding with `script_name`                                                                       | Service binding to a `WorkerEntrypoint` that forwards to the object  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Hops                                         | MCP Worker → object                                                                                             | MCP Worker → board Worker → object; the snapshot is serialised twice |
| Board Worker code                            | none beyond the object's methods                                                                                | an entrypoint class repeating each method                            |
| Vitest Workers pool                          | works: the board Worker is an auxiliary Worker built from `wrangler.json` (`vitest.config.ts`)                  | works                                                                |
| One `wrangler dev` session with both configs | works                                                                                                           | works                                                                |
| Two `wrangler dev` processes                 | bound and "[connected]", but every call failed with "Network connection lost" (wrangler 4.145, in this sandbox) | failed the same way                                                  |
| Alchemy                                      | `Cloudflare.DurableObject("BoardRoom", { scriptName })`                                                         | a service binding                                                    |

Both fail across dev processes here, so that is no reason to pay the extra
hop: the Durable Object binding stays. Local development and the e2e run
use one `wrangler dev` session with three configs, where a 20-line
dev-only Worker (`dev/both.ts`) takes the port and hands `/mcp` and the
metadata path to the MCP Worker and everything else to the board Worker
(`aube run serve:mcp`).

### Where it is served: its own hostname

`https://mcp.<domain>/mcp`, a custom domain on the MCP Worker.

- The resource URL is the token's audience context and what the
  protected-resource metadata names; the Worker derives it from the
  request's origin, so a workers.dev preview (`…-mcp.<account>.workers.dev`)
  works with no configuration, and the shape is the same in every stage.
- A path on the board's host would need either zone routes by pattern
  (which workers.dev previews do not have, and which silently depend on
  route precedence against the board Worker's catch-all domain), or the
  board Worker forwarding `/mcp` through a service binding, which makes the
  two Workers depend on each other in a circle (neither can be deployed
  first) and puts MCP traffic back through the board Worker.
- RFC 9728 lets the metadata live at
  `/.well-known/oauth-protected-resource/mcp` on the resource's own host,
  which is where it is. MCP clients take whatever URL the user pastes.
- CORS does not arise: assistants call from servers. A request carrying a
  foreign `Origin` is refused; the metadata document alone is
  `Access-Control-Allow-Origin: *`.
- The standalone authorization server (§9) will want `/authorize`,
  `/token` and a consent page; they fit on this host without touching the
  board's Content-Security-Policy.

### Repository layout

| Path                                     | What                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.json`, `src/index.ts`          | The board Worker                                                                                                                                                                            |
| `wrangler.mcp.json`, `src/mcp/worker.ts` | The MCP Worker (`BoardRoom` bound with `script_name: "tabletop"`)                                                                                                                           |
| `src/room-document.ts`                   | The contract and the room's side of it; the only module both import code or types from, besides `src/pass.ts` (key import)                                                                  |
| `src/ops/`, `src/mcp/`                   | MCP Worker only                                                                                                                                                                             |
| `wrangler.dev.json`, `dev/both.ts`       | Local development and e2e: one port for both                                                                                                                                                |
| `alchemy/index.js`                       | `Tabletop(id, { …, mcp: { authorizationServer, audience?, domain?, workerName? } })` deploys the second Worker; without `mcp` the board deploys alone. Type-checked, not deployed from here |
| `vitest.config.ts`                       | Two projects: `board` (the board Worker's suite) and `mcp` (the MCP Worker with the board Worker beside it)                                                                                 |

Standalone mode gets no MCP Worker yet (§9); the helper ignores `mcp`
there.

## 2. What is built and tested

`aube run test`: two Vitest projects, the second with both Workers in
workerd. `aube run e2e`: 7 specs.

- `apply_ops` with all eleven ops, through tldraw's engine on the stand-in,
  from the MCP Worker against a real `BoardRoom` in the board Worker with
  no session (`test/mcp/apply-ops.test.ts`): per-op failure with rollback,
  an invalid batch applying nothing, `{created}` run memory in the room
  across calls, a named page on a board with several, read-only and
  revoked grants, one patch to a connected session.
- The conflict model under concurrent edits (`test/mcp/concurrency.test.ts`,
  §1a).
- The MCP endpoint, both protocol eras; `get_board_info`, `get_page_info`,
  `get_cluster_info` on tldraw's page-read code and `search_shapes` on
  shape text, each result opening with the untrusted-data notice
  (`test/mcp/mcp.test.ts`).
- tldraw's 38 engine tests (`test/mcp/upstream`), the text-measurement
  comparison (`test/mcp/text-measure.test.ts`), the fidelity comparison
  (`e2e/measure/fidelity.spec.ts`).
- Playwright (`e2e/tests/ops.spec.ts`): a member's open tab shows the
  shapes without a reload, every label fits inside its shape, and after a
  reload the room's shape and binding records are what the server wrote.

What is not proven is listed in §0.

## 3. Text measurement without a DOM

### Fonts

`@tldraw/assets/fonts/` ships 16 woff2 files: Shantell Sans Informal
(`draw`), IBM Plex Sans / Serif / Mono (`sans`, `serif`, `mono`), each in
regular (Plex "Medium"), bold, italic, bold italic. All have 1000 units per
em, Latin, Latin Extended and Cyrillic; none has CJK or emoji. Sizes:
151-155 KB per Shantell face, 47-78 KB per Plex face.

### Why not compact advance and kerning tables

Tried first. Per-glyph advances plus a pairwise kerning model, compared
with full shaping over a sentence corpus:

| Font               | Advances only | Advances + pair kerning |
| ------------------ | ------------- | ----------------------- |
| IBM Plex Sans      | 3.4% off      | exact                   |
| Shantell Sans      | 5.4% off      | 1.1% off                |
| Shantell Sans Bold | 5.6% off      | 1.3% off                |

Shantell Sans, tldraw's default font, substitutes glyphs by context
(`calt`), so 80 of 326 Latin characters change advance depending on their
neighbours, and its kerning has 61,107 non-zero pairs over that set (237 x
213 distinct classes). A table model is both large and 1% wrong, which is
enough to move a line break. Rejected for `draw`; it remains an option to
make Plex faster.

### What is built

`src/ops/text/measure.ts`: fontkit 2.0.4 (MIT, pure JS, its own GSUB/GPOS
shaper and woff2 decoder) shapes tldraw's own woff2 files, embedded as
base64 by `scripts/build-font-data.ts`. Line breaking is ours: a reduced
UAX #14 (after spaces, after a hyphen between letters, around ideographs
and emoji, never before closing punctuation; trailing spaces hang; a word
wider than the line breaks between graphemes when `overflow-wrap` applies).
The box model mirrors tldraw's measuring element (`width: max-content`
between a min and max width, line height `round(fontSize x 1.35)`).
`src/ops/text/sizing.ts` restates how tldraw's geo, note and text utils
turn a measurement into `growY`, `fontSizeAdjustment` and a text shape's
size.

### Error against the real editor

`e2e/measure` runs the real tldraw editor (`editor.textMeasure.measureHtml`
and the bounds and props of shapes it creates) over 92 labels x 4 families
x 4 sizes = 368 cases in four browsers. `test/mcp/text-measure.test.ts`
compares in workerd and fails if the reference drifts.

Reference: Chromium with font hinting off, which is how Chrome lays text
out on macOS, Windows and Android. 304 cases use only tldraw's fonts
(Latin, Polish diacritics, long words, a URL, multi-line, hyphens, bold
runs); 64 need fallback fonts (CJK, emoji).

| Metric                     | tldraw fonts: exact | max error | CJK, emoji: exact | max error |
| -------------------------- | ------------------- | --------- | ----------------- | --------- |
| Label width (one line)     | 96.4% within 0.5 px | 1.13 px   | 75.0%             | 3.76 px   |
| Label line count at 168 px | 100%                | 0         | 100%              | 0         |
| Text shape width           | 96.4% within 0.5 px | 1.55 px   | 75.0%             | 5.17 px   |
| Text shape height          | 100%                | 0         | 100%              | 0         |
| Text 220 px wide: height   | 100%                | 0         | 93.8%             | 49 px     |
| Geo 200x100: `growY`       | 100%                | 0         | 100%              | 0         |
| Note: `growY`              | 100%                | 0         | 100%              | 0         |
| Note: `fontSizeAdjustment` | 100%                | 0         | 100%              | 0         |

The width misses are all Shantell Sans on words of 30+ letters (fontkit and
HarfBuzz differ by about 0.2% there). A 49 px miss is one line.

Other browsers, same measurer, tldraw fonts only:

| Browser                           | Line count | Geo `growY` | Note `growY` | Width p95 / max |
| --------------------------------- | ---------- | ----------- | ------------ | --------------- |
| Chromium, hinting off (reference) | 100%       | 100%        | 100%         | 0.17 / 1.13 px  |
| Firefox                           | 97.7%      | 97.7%       | 98.0%        | 0.22 / 1.14 px  |
| WebKit                            | 97.7%      | 97.7%       | 98.7%        | 1.28 / 6.56 px  |
| Chromium, Linux default hinting   | 99.3%      | 99.3%       | 99.7%        | 10.6 / 28.4 px  |

**Browsers disagree with each other more than the server disagrees with
Chrome.** Firefox and WebKit break a URL after a slash; Chrome does not.
Chrome on Linux rounds each glyph to whole pixels (2% wider in mono). A
board already wraps differently for two people today; tldraw stores the
`growY` of whoever typed. The server behaves like one more Chrome-on-Mac
client.

### Where it breaks, and the fallback

- **Glyphs outside tldraw's fonts**: a browser uses a system font. The
  server uses 1 em for East Asian wide characters, 1.245 em for emoji
  (Noto Color Emoji's advance), 0.6 em otherwise, and the measurement is
  marked `approximate`. Heights were still right in 100% of geo and note
  cases; wrapping of mixed CJK text at a fixed width was wrong in 4 of 64.
  The op result should say "sized approximately" (not yet surfaced).
- **Italic**: the regular face is used (not flagged yet). Adding the eight
  italic faces costs 700 KB of woff2.
- **Lists, headings, code marks** in rich text: read as paragraphs.
  Assistants write plain text, so this matters only for `rename` of a shape
  a person formatted; such shapes should keep their formatting and be
  flagged.
- **Right-to-left text**: not handled.

### Cost

| Item                                                                    | Number                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Bundles                                                                 | see §1a: the measurer and fonts are in the MCP Worker only |
| fontkit + 8 font faces                                                  | about 1.4 MiB raw, 720 KiB gzip                            |
| First measurement per family (woff2 decode and parse), once per isolate | draw 140-200 ms; sans 36-56; serif 21-33; mono 18-22       |
| A label whose words were seen before                                    | 0.13 ms                                                    |
| A label of three unseen words                                           | 2.3 ms                                                     |

Workers accept 10 MB gzip on the paid plan and 3 MB on the free plan.
Words are shaped once per font and cached (20,000 entries per isolate).

### Should a connected browser correct server sizes afterwards?

**No, and tldraw does not do it either.** Checked in tldraw 5.6:

- `ShapeUtil.onBeforeCreate` / `onBeforeUpdate` (where geo and note compute
  `growY`) are called only from `Editor.createShapes` / `updateShapes`. The
  sync client applies remote records with `store.applyDiff` and never calls
  them, and nothing re-measures on load. A geo whose stored height is too
  small for its label simply overflows until someone edits it.
- Text shapes store no height: `TextShapeUtil` measures at render time, so
  a text shape always fits in every browser. The server needs its size only
  for placement.
- What a browser does run for remote records is `ArrowBindingUtil`
  (`onAfterCreate` re-parents the arrow and may move its index). The engine
  writes the parent and index tldraw would choose, and the e2e test shows
  no browser changes them.

A client-side "fix-up" pass would make every connected browser write
competing patches, each with its own platform's metrics, and would add
entries to nobody's undo stack. The server's numbers are within one
platform's variance; leave them.

## 4. Geometry, arrows, validation, concurrency

### Geometry (`src/ops/geometry.ts`)

| Shape                                | From the record alone                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| geo                                  | `w` x (`h` + `growY`)                                                                                             |
| note                                 | 200 x (200 + `growY`), times `scale`                                                                              |
| text                                 | measured (§3), times `scale`                                                                                      |
| frame, image, video, embed, bookmark | `w` x `h`                                                                                                         |
| line                                 | box of its points (a spline can overshoot by a few px)                                                            |
| draw, highlight                      | box of the points decoded with tlschema's `b64Vecs` (stroke width ignored)                                        |
| group                                | union of its children                                                                                             |
| arrow                                | its anchors through its bindings, straight or the circular arc tldraw draws for `bend`, cut at the boxes it joins |

Position and rotation compose through frames and groups to page
coordinates. Approximate today: non-rectangular outlines (an arrow is cut
at an ellipse's box, not its curve), elbow arrows, arrowhead and label
extents, crop on images. None needs tldraw's shape utils; each is a small
pure function when wanted.

Running tldraw's own shape utils in workerd: `@tldraw/editor` and `tldraw`
import in the Workers pool (541 and 976 exports), but `new Editor(...)`
throws `Cannot read properties of undefined (reading 'ownerDocument')`:
the editor needs a container element, and its `TextManager` needs layout
(`getBoundingClientRect`), which no DOM shim provides. Bundle weight alone:
`@tldraw/editor` 2771 KiB (565 KiB gzip), `tldraw` 5188 KiB (1031 KiB
gzip). Not worth it; the SDK licence also covers that code.

### Arrows and bindings

`connect` writes an arrow record and one binding record per bound end
(`isPrecise: false`, anchor at the centre): tldraw then draws the arrow to
the shape's outline wherever the shape moves. Verified in a browser: bound,
follows its shapes, unchanged after reload. The arrow goes above the higher
of the shapes it joins and below the next non-arrow sibling, which is where
`ArrowBindingUtil` would put it. When the straight line crosses another
shape the engine tries bends of 40 to 360 px either side and takes the
first that clears both the course and the label (the bend's side follows
tldraw's `middle = mid + per(u) * -bend`).

### Validation, ids, order, rich text

- Every record an op wrote is validated with `createTLSchema()`'s record
  types before the batch is written; a refusal fails that op only. Records
  are built at the current schema version, so there is nothing to migrate;
  a tldraw upgrade needs the builders in `src/ops/records.ts` updated with
  the schema (the validation test catches a miss).
- Ids: the model's short id `castle` is `shape:castle`; without one,
  `createShapeId()`. Results report ids without the prefix, as upstream.
- Order: fractional index keys from `@tldraw/utils` (`getIndexAbove`,
  `getIndexBetween`).
- Rich text: `toRichText` from tlschema (one paragraph per line).
- The room validates again on commit (§1a), so a caller's mistake cannot
  reach storage.

### Concurrency and failure

- The batch is computed outside the room, from a snapshot, so people can
  edit in between. The room's commit checks per record that nothing the
  batch rested on changed and writes atomically; on a conflict the batch is
  recomputed, at most three times (§1a, with its tests). One storage
  transaction is one broadcast: a connected session receives a 3-op batch
  (5 records) as a single patch.
- Contract, tested: an op that fails is rolled back to the mark taken
  before it, and the rest apply; a batch that fails the schema applies
  nothing. Through MCP the SDK rejects a schema failure before the board is
  touched, with its own wording ("Input validation error: ...").
- People drawing at the same time: a client push that arrives after the
  batch is rebased by the room onto it; edits to different properties
  merge, the same property is last-writer-wins.
- **Undo**: server writes are in nobody's undo stack. Ctrl+Z in a tab will
  not remove what the assistant added, and a person who undoes their own
  move of an assistant-made shape gets their own change undone only. The
  remedy is server-side: every created shape carries `meta.agent.batchId`,
  so "undo that batch" can be a later tool or a button (remove what the
  batch created; restoring edits needs a stored inverse diff, not built).

### Cost on a large board

Generated board: 5,000 shapes (boxes, notes, labels) and 980 bound arrows,
7,941 records, 3.8 MB of JSON.

| Step                                                 | Time       |
| ---------------------------------------------------- | ---------- |
| Build the document view                              | 4 ms       |
| Page box of every shape, cold (measures 5,000 texts) | 135 ms     |
| Same, warm (boxes cached per record)                 | 14 ms      |
| Clusters for the page (1,937 clusters)               | 180 ms     |
| One `add` beside a target, warm / cold               | 32 / 99 ms |
| One `connect`, warm                                  | 16 ms      |
| 1,000 `add` ops in one batch                         | 0.9-1.2 s  |
| 980 `connect` ops in one batch on 5,000 shapes       | 4.7 s      |

A Durable Object request has 30 s of CPU by default. The first version of
the spike took 159 s for the 980 connects (every op re-measured every
shape); caching boxes per record and filtering route obstacles fixed it,
and the benchmark stays worth running.

## 5. Operations

Superseded: all eleven ops, `{description}` references, collision
avoidance, label and arrow layout and untangle come with tldraw's engine
(§0). The 15 days estimated here for writing them are no longer needed.

## 6. Page inspection

Superseded: `get_page_info` and `get_cluster_info` run tldraw's
`shapeClusters.ts` and `mcpPageRead.ts` unchanged, fed by measurements from
records (`src/mcp/page-read.ts`), with upstream's paging (40K and 60K
characters, cursors bound to the page and cluster ids) and result shapes.
Costs are in §0. Our own clustering was removed.

## 7. Screenshots (`get_cluster_screenshot`)

| Option                                                                                           | Works offline | Fidelity                       | Cost and limits                                                                                                                                                                                                                                                                                                                                           | Verdict                                           |
| ------------------------------------------------------------------------------------------------ | ------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| (a) A connected tab renders (`editor.toImage`) and posts the PNG back through the Durable Object | No            | Exact (it is the editor)       | No infrastructure cost; needs a job broker (ack and work timeouts, a signed job id for the reply route); the tab must be visible; a tab can forge the image, which only its own account's assistant sees                                                                                                                                                  | Use when a tab of the acting account is connected |
| (b) Cloudflare Browser Run opens the board headlessly                                            | Yes           | Exact, with Linux font metrics | Workers Paid: 10 browser hours a month included, then $0.09 per hour; 10 concurrent browsers included, then $2 each; free plan 10 minutes a day; idle timeout 60 s; a new browser takes seconds to launch (not measured here), reusable sessions cut that; at 10 s per screenshot the included hours are 3,600 screenshots a month                        | Use when nobody is online                         |
| (c) Server-side SVG without a DOM, rasterised with resvg WASM                                    | Yes           | Would be approximate           | tldraw 5.6 has no DOM-free export: `getSvgString` renders React into a document and measures text there, and the editor does not construct in workerd (§4). We would write our own renderer for every shape, dash style, hand-drawn stroke, arrowhead and fill pattern. `@resvg/resvg-wasm` is 2.5 MB unpacked; fonts must be passed in; CPU not measured | No: weeks of work to draw a worse picture         |

**Recommendation: (a) when the account has a visible tab, otherwise (b).**
Offline is a requirement, so (b) is the one that must exist; build it
first and add (a) as the fast path if latency or cost shows up.

How (b) authenticates to a private board: the Worker signs a **render
pass**, an ordinary pass for a system person (`sub` `s:render`, 60 s life,
the board's current link version, plus `render: true`), and gives Browser
Run a URL of the tabletop's own render page with the pass in the fragment.
The page opens the sync socket read-only (the room must refuse writes from
a render pass via `TLSocketRoom`'s read-only session mode), zooms to the
cluster's bounds, waits for fonts and images, and exposes the PNG. In
hosted mode the Worker cannot sign passes (only the host can), so either
the host contract gains a "render pass" request, or the room accepts an
internal one-time token minted and checked inside the Durable Object.
The second keeps hosts out of it and is what I would build.

Limits to copy from upstream's contract: longer side 64-2560 px, at most 8x
enlargement, PNG returned as MCP image content after a text block naming
the page.

## 8. The MCP server

| Option                                            | Finding                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` SDK (`McpAgent`, its `createMcpHandler`) | 11 MB package with peers for AI SDKs; `McpAgent` is a Durable Object per MCP session, which we do not need: every tool call names its board, and state lives in the board's object                                                                                                                                        |
| `@modelcontextprotocol/sdk` 1.x                   | Works in workerd with the web-standard transport, but is the 2025-era SDK (latest revision 2025-11-25) and drags Express-era dependencies into the graph                                                                                                                                                                  |
| **`@modelcontextprotocol/server` 2.4.0**          | Depends only on its core and zod 4; has a workerd export; `createMcpHandler(factory)` serves the 2026-07-28 revision (no handshake, per-request envelope, `Mcp-Method` / `Mcp-Name` headers) and falls back to stateless serving for 2025 clients (`initialize`, 2025-03-26 to 2025-11-25) from the same tool definitions |
| Hand-written JSON-RPC (what upstream does)        | About 300 lines for one era; two eras with header and body cross-checks is real protocol work that the SDK already tests                                                                                                                                                                                                  |

**Picked: `@modelcontextprotocol/server`, stateless, in the Worker.**
Built and tested in the Workers pool: 401 with `WWW-Authenticate` and
RFC 9728 metadata, `initialize` + `tools/list` (2025-11-25), handshake-free
`tools/list` and `tools/call` (2026-07-28), an `apply_ops` call that writes
a board nobody has open. Streamable HTTP answers arrive as JSON or a
one-event SSE stream; there is no session id and no GET stream. Image
content is a `{type: "image", data, mimeType}` block, which the SDK passes
through. ChatGPT and Claude both connect over streamable HTTP with OAuth;
which revision each sends today was not captured, and the handler serves
both.

A request with an `Origin` header that is not the tabletop's own is
refused: assistants call from servers.

## 9. Authorization

Principle: an assistant acts for an account, on boards that account chose,
with read or write per board. Guests have no account and cannot grant
anything. A token for one board says nothing about another.

### Hosted mode (built: the resource side)

The host is the OAuth 2.1 authorization server. The MCP Worker is a
protected resource.

```
Assistant client            MCP Worker (resource)             Host (authorization server)     Board DO
      |  POST /mcp (no token)        |                                  |                         |
      |----------------------------->|                                  |                         |
      |  401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"
      |<-----------------------------|                                  |                         |
      |  GET that metadata           |                                  |                         |
      |----------------------------->|  {resource, authorization_servers:[host], scopes_supported}
      |<-----------------------------|                                  |                         |
      |  GET host/.well-known/oauth-authorization-server                |                         |
      |---------------------------------------------------------------->|                         |
      |  authorize: code + PKCE, client_id = its metadata document URL, resource = tabletop /mcp  |
      |---------------------------------------------------------------->|                         |
      |                              |      member signs in; consent page lists THEIR boards,     |
      |                              |      each off / read / edit; host stores the grant         |
      |  code -> token request (code_verifier, resource)                |                         |
      |---------------------------------------------------------------->|                         |
      |  access token: RS256 JWT, aud = MCP audience, boards: [{board, access, grant, title}]      |
      |<----------------------------------------------------------------|                         |
      |  POST /mcp  Authorization: Bearer <token>                       |                         |
      |----------------------------->| verify signature, iss, aud, exp with ISSUER_PUBLIC_KEY     |
      |                              | boardId in token? else "not found"                         |
      |                              |-- mcpApplyOps(board grant, ops) ------------------------->|
      |                              |                 grant < board's grant version? "revoked"   |
      |                              |                 grant > it? move the board on              |
      |                              |<-- result ------------------------------------------------|
      |  tool result                 |                                  |                         |
      |<-----------------------------|                                  |                         |
```

Revocation without calling the host per request, the same way links work:
each board has a **grant version** in its Durable Object. A token entry
carries the version current when it was signed. The room refuses a lower
one and moves on when it sees a higher one. To revoke, the host increments
the board's grant version, signs later tokens with it, and tells the room
at once (below), so outstanding tokens die immediately instead of at
expiry. Tokens live one hour at most; refresh tokens stay at the host.
Coarse by design: revoking one client on a board re-issues the others on
their next refresh.

**Addition to the README's host contract** (to be moved there when built):

> #### Assistants (MCP), optional
>
> | Variable                   | Meaning                                                                                                  |
> | -------------------------- | -------------------------------------------------------------------------------------------------------- |
> | `MCP_AUTHORIZATION_SERVER` | On the MCP Worker: the host's authorization server (issuer origin)                                       |
> | `MCP_AUDIENCE`             | The `aud` of MCP access tokens. Default `tabletop-mcp`; must differ from the pass and deletion audiences |
>
> The host runs an OAuth 2.1 authorization server (authorization code with
> PKCE; Client ID Metadata Documents; `resource` indicators) and signs
> access tokens for the resource `https://<tabletop>/mcp` with the pass
> key:
>
> | Claim        | Value                                                                   |
> | ------------ | ----------------------------------------------------------------------- |
> | `iss`, `aud` | `ISSUER`, `MCP_AUDIENCE`                                                |
> | `sub`        | The member's id                                                         |
> | `client_id`  | The assistant client                                                    |
> | `boards`     | Up to 100 of `{"board", "access": "read" \| "write", "grant", "title"}` |
> | `iat`, `exp` | Required; at most one hour                                              |
>
> The consent page lists only boards the member owns (or may share) and
> lets them choose none, read or edit for each. `grant` is the board's
> grant version, an integer from 0 the host keeps beside the link version.
> To revoke, the host raises it and sends
> `POST /rooms/<board>/mcp/revoke` with a token of audience
> `MCP_REVOCATION_AUDIENCE` and the claims `board`, `grant`, `exp`
> (answered 204, repeatable). Deleting a board ends its grants.

Built (on the MCP Worker, which also takes `ISSUER` and
`ISSUER_PUBLIC_KEY`): the two variables, token verification, `/.well-known` metadata, the
grant version check and `BoardRoom.revokeMcpGrants`. Not built: the
`/mcp/revoke` route and anything on a host.

### Standalone mode: WorkOS, then our own board step (design)

Decided: WorkOS AuthKit is the OAuth authorization server for the MCP
resource; the MCP Worker then narrows the token's account to boards and
access a person picked on a page of ours.

What AuthKit gives, from its MCP documentation (`workos.com/docs/authkit/mcp`,
read 2026-11-23):

|                     |                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client registration | Client ID Metadata Documents, off by default, turned on in the dashboard (Connect, Configuration); Dynamic Client Registration for older clients (`/oauth2/register`)                                                                              |
| PKCE                | `S256` advertised                                                                                                                                                                                                                                  |
| Resource indicators | The MCP endpoint's URL is added as a Resource Indicator in the dashboard; the access token's `aud` is then that URL. Without one, `aud` is the environment's client id and `resource` is ignored                                                   |
| Token               | A JWT; issuer `https://<authkit domain>`; keys at `https://<authkit domain>/oauth2/jwks`; `sub` is the WorkOS user id (the same id our `accounts.id` holds); `org_id` when scoped to an organization; `sub_profile: "ai_agent"` marks agent tokens |
| Metadata            | `https://<authkit domain>/.well-known/oauth-authorization-server`                                                                                                                                                                                  |
| Scopes and consent  | `openid`, `profile`, `email`, `offline_access` only; AuthKit shows its own consent prompt; nothing per resource or per board                                                                                                                       |
| Not stated there    | Whether the token carries `client_id`; the board step below needs to know which client a token belongs to, so this must be checked on a real token before building (the introspection endpoint needs a first-party client's credentials)           |

The sequence:

```
Assistant client        MCP Worker (mcp.<domain>)          WorkOS AuthKit        Board Worker / D1
   | POST /mcp (no token)      |                                |                      |
   |-------------------------->| 401, resource_metadata=...     |                      |
   | GET /.well-known/oauth-protected-resource/mcp              |                      |
   |-------------------------->| {resource, authorization_servers: [authkit domain]}   |
   | authorize (PKCE, client id = its metadata URL, resource = https://mcp.<domain>/mcp)
   |----------------------------------------------------------->| sign in, AuthKit's consent
   | code -> token                                              |                      |
   |<-----------------------------------------------------------| JWT: sub, aud = resource
   | POST /mcp  Bearer <jwt>   |                                |                      |
   |-------------------------->| verify with JWKS (iss, aud, exp); refuse sub_profile ai_agent
   |                           | grants for (sub, client)? ------------------------- D1 |
   |                           |   none: every tool answers "No boards are connected yet.
   |                           |   Ask the person to open https://<tabletop>/assistants"
   |                           |                                |                      |
   Person, in a browser, signed in to the tabletop:             |                      |
   |   GET /assistants  -> the clients that hold a token for this account (seen by the MCP
   |   Worker, recorded in D1), and for each the boards where the account is owner or manager,
   |   each off / read / edit.  POST with CSRF, as the other owner actions.            |
   |                           |                                |                      |
   | POST /mcp tools/call      |                                |                      |
   |-------------------------->| grants for (sub, client) -> board grant {board, access,
   |                           |   grant version, role} --------- readDocument / commitDocument
```

- **Where grants live**: D1, on the standalone side, read by the MCP Worker
  through a D1 binding to the same database.
  `assistant_clients (account_id, client_id, name, first_seen, last_seen)`,
  written by the MCP Worker the first time it sees a valid token;
  `assistant_grants (account_id, client_id, board_id, access, PRIMARY KEY
(account_id, client_id, board_id))`, written by the board Worker's
  `/assistants` page.
- **The role is looked up, not stored in the grant**: on each call the MCP
  Worker joins the grant with `boards.owner_id` and `visits.role`; an
  account that is no longer owner or manager has no usable grant, whatever
  the row says. The room still gets `role` in the board grant and refuses
  anything else.
- **Grant version**: `boards` gains `grant_version`; demoting a manager or
  switching a board off for a client raises it (`endAssistants` on the
  room, built), and the MCP Worker passes the current one. With grants
  looked up per call this is a second lock, kept so both modes present the
  room with the same thing.
- **Cost of a call**: one D1 read (grants joined with roles) before the
  room; JWKS cached in the isolate.
- If the token has no `client_id`, grants are per account instead of per
  client ("your assistants may read these boards"), which is weaker and
  should be said on the page.

### Guests, attribution, audit

- An assistant always acts for an account that owns the board or was given
  it. A guest link grants nothing to an assistant.
- In the document, assistant writes are attributed to a system author, not
  a person: created shapes get `meta.agent = {batchId, runId?, at}` and
  edited ones `meta.agentEdit` (built). No account id is written into the
  document, since everyone on the board can read it. The People sheet can
  show "Assistant" while a batch is recent.
- Audit (built): one log line per call, `mcp.call` with account, client,
  board, tool and outcome, and `board.mcp_ops` with applied and failed
  counts and how many people were connected. Never shape text, names or
  ops.

## 9b. Roles (built), and a record of changes (design)

### Roles on a board (built)

| Role     | May                                                                      | Who                                                         |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `write`  | draw, roll, upload                                                       | anyone holding a pass: guests (always `write`) and accounts |
| `manager` | all of that, and connect an assistant to the board, read-only or editing | accounts the owner makes managers                            |
| `owner`  | all of that; rename, reset the link, delete; make and unmake managers     | the account that made the board                             |

An assistant never holds a role. It acts for one account, on boards where
that account is `manager` or `owner`, with the access that person picked.

What changed in the contract:

- **The pass** has `role: "owner" | "manager" | "write"`. `owner: boolean`
  stays readable for one step: a pass without `role` is `owner` or `write`
  by that flag; a pass with both goes by `role`. A pass that gives a guest
  (`g:`) more than `write`, or names an unknown role, is refused (403).
  The standalone Worker signs both claims; the reference host
  (`e2e/fake-host.ts`) sends `role`.
- **The bootstrap answer**'s `person` has `role` beside `owner`.
- **An assistant's board grant** (in the access token, and in every call to
  the room) has `role: "manager" | "owner"`: the role of the account it acts
  for. The MCP Worker refuses a token entry with any other role, and the
  room refuses the call again on its side (`readDocument`,
  `commitDocument` answer "revoked"), so no Worker bound to the room can
  act for someone who is not a manager.
- **Hosted mode**: the host keeps roles and its own permissions page; it
  names the person's role in each pass, offers on its consent page only
  boards where the member is manager or owner, puts that role in the token,
  and raises the board's grant version (and tells the room, §9) when a
  manager is demoted.
- **Standalone mode**: `visits.role` (`write` or `manager`, migration
  `0003_board_roles.sql`); the owner is the board's `owner_id`.
  `GET /api/boards/<id>/people` lists the accounts that joined by link;
  `POST /api/boards/<id>/people/<account>/role` sets one, with the same
  origin and CSRF checks as the other owner actions. Taking manager back
  calls the room's `endAssistants`, which ends every assistant on the board
  at once. The page is "People" on a board's row of the front page
  (`client/src/board-people.tsx`): each person with a "Manager" checkbox,
  and a line saying what a manager can do; guests are not listed and cannot
  be promoted.
- Tests: `test/roles.test.ts` (every refusal: signed out, not the owner,
  no CSRF token, another origin, a role that is not one, an account that
  never joined, a guest; the pass's role values; the room's refusal),
  `e2e/tests/roles.spec.ts` on a phone, in English and Polish.

### Recent changes, with undo for an assistant's batch

Decided: people and assistants both, a summary per actor and time ("Ania
changed 12 shapes on Town"), 200 entries or 30 days, undo for an
assistant's batch. A list in the board ("Recent changes"), most recent
first.

- **Store.** A `changes` table in the room's SQLite: `seq, at, actor_kind
(person | assistant), actor_id, actor_name, page, batch_id, created,
changed, removed, undo` and a cap (the last 200 entries or 30 days).
  Counts and names only in the row itself; never shape text in logs.
- **Assistants.** `commitDocument` writes one row per batch: the account
  the assistant acts for and its client name, the counts, and `undo`, the
  inverse diff the room computes in the same transaction (the previous
  value of every record the batch overwrote or removed, and the ids it
  created). That is the one place every assistant write passes through.
- **People.** The sync room knows which session a push came from
  (`TLSocketRoom`'s per-session message hook; the session's pass names the
  person). Pushes are coalesced per person and page into one row per
  minute of activity ("Ania changed 12 shapes on Dungeon"). No inverse is
  kept: people have their own undo.
- **Undo a batch.** `undoBatch(batchId)`, for managers, from the list or
  as an MCP tool: applies the stored inverse through the same commit path,
  under the precondition that the records it restores or removes are still
  as the batch left them. Records someone has since edited are skipped and
  named ("3 of 14 shapes were changed afterwards and were left alone"), so
  an undo never destroys a person's later work. Shapes the batch created
  carry `meta.agent.batchId`, which the list uses to highlight them.
- **Reading it.** A room call for the client's sheet and a `get_changes`
  tool later; rows are untrusted data like any other board content (names
  are user-chosen).

## 9c. Board names belong to the tabletop (design)

Decided: the host stores a board's id or link and "doesn't need their
names". So the title lives with the board in both modes, and
`create_board` and `rename_board` are tools in both.

- **Where the title lives.** In the room: a `title` in the `board` row of
  its SQLite, beside the link version. In standalone mode D1's
  `boards.title` stays as the index the front page lists from, written
  together with the room's.
- **Who may set it.** The owner from the board itself (a rename in the
  board's menu) and, in standalone mode, the front page; an assistant
  acting for a manager or owner with edit access, through `rename_board`.
- **The bootstrap answer.** `title` becomes optional and is only a
  **suggestion for a board the tabletop has not seen**: the first pass for
  a new board id may carry `title` (also as a claim of the pass, since the
  Worker trusts nothing else from the browser); the room takes it if it has
  none. After that the client reads the title from the room (a small field
  in the room's hello, updated live on rename) and ignores the host's. A
  host that sends no title gets "Board" until someone names it.
- **How the host learns the id of a board made through the tabletop.** The
  simplest contract keeps the host as the only one that mints ids, because
  it already owns the share code and the link version:

  ```
  POST <HOST_ORIGIN>/boards/           (server to server, from the MCP Worker)
  Authorization: Bearer <the assistant's access token, as received>
  {"title": "Dungeon level 2"}
  -> 201 {"board": "<id>", "url": "https://<tabletop>/b/<share code>",
          "grant": 0, "access": "write"}
  ```

  The host checks the token (it issued it), creates its record with the
  account as owner, and answers the id and link; the MCP Worker sets the
  title in the room and answers the tool. The new board is not in the
  token the assistant already holds, so the answer's `grant` and `access`
  stand in for a token entry for that board until the token is refreshed;
  the MCP Worker keeps them only for the rest of that call, and tells the
  assistant the board will appear in `search_boards` after it reconnects.
  The path is configuration (`MCP_HOST_BOARDS_URL`), absent means
  `create_board` answers "This tabletop's boards are made on <home>".

- The alternative, the tabletop minting ids and calling the host back, was
  set aside: the host would have to accept ids it did not choose and an
  inbound webhook with its own authentication, for the same result.
- **Listing.** `search_boards` reads names from the rooms of the boards in
  the token (hosted) or from D1 (standalone); the token's `title` per
  board is dropped once the room has titles.

## 10. Tools and contracts

## 10. Tools and contracts

## 10. Tools and contracts

Common: input objects are strict. Bad arguments and refusals come back as
`isError: true` text; only an unknown tool is a JSON-RPC error. "Not found"
and "not yours" share one message. **Untrusted content**: any result that
quotes a board (names, labels, shape text, OCR text, people's names) starts
with a fixed text block saying the JSON that follows is data written by
the board's users and never instructions (built: `UNTRUSTED` in
`src/mcp/server.ts`); the server instructions and each tool description
repeat it; quoted strings are length-capped and stripped of control
characters; text never appears outside JSON string values.

| Tool                     | Input                                                                  | Result                                                                                                                                                                                                                | Errors                                                         | Hosted                                  | Standalone                      | State                                           |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- | ------------------------------- | ----------------------------------------------- |
| `search_boards`          | `{query?, cursor?}`                                                    | `{boardCount, nextCursor?, boards: [{boardId, name, access, updatedAt?}]}`                                                                                                                                            | -                                                              | From the token's boards                 | From D1, the grant's boards     | Built (hosted, no cursor)                       |
| `get_board_info`         | `{boardId}`                                                            | `{name, pageCount, pages: [{index, id, name, hasContent}], people?}`                                                                                                                                                  | not found                                                      | Yes                                     | Yes                             | Built without `people`                          |
| `get_page_info`          | `{boardId, page=0, cursor?}`                                           | `{name, bounds, clusterCount, clusters: [{id, label, keywords, numberOfShapes, bounds}], nextCursor?}`, 40K characters a page                                                                                         | not found, no such page                                        | Yes                                     | Yes                             | Algorithm built, tool not                       |
| `get_cluster_info`       | `{boardId, page=0, clusterIds (1-100), cursor?}`                       | `{pageName, clusters: [{label, keywords, numberOfShapes, shapes: [{id, type, pageX, pageY, pageRotation, parentId, props (rich text as `text`), bindingFromId?, bindingToId?, pointCount?}]}], nextCursor?}`, 60K cap | unknown cluster id                                             | Yes                                     | Yes                             | Deferred                                        |
| `get_cluster_screenshot` | `{boardId, page, clusterIds, theme=light, size=2560 (64-2560)}`        | text block (page name) + PNG image block                                                                                                                                                                              | renderer busy or unavailable                                   | Yes                                     | Yes                             | Deferred (§7)                                   |
| `apply_ops`              | `{boardId, ops (1-1000, 1 MiB), page?, runId? (<=200)}`                | `{batchId, applied, errors, results: [{index, op, ok, shapeIds, message, adjusted?}], pageId, pageName}`                                                                                                              | read-only grant; invalid batch (nothing applied); no such page | Yes                                     | Yes                             | Built: 5 of 11 ops                              |
| `get_user_state`         | `{boardId, userId?}`                                                   | `{userId, pageId, pageName, selectedShapeIds, viewport}` or presence of another person                                                                                                                                | "not on this board right now"                                  | Yes                                     | Yes                             | Deferred; needs the account's session connected |
| `get_board_users`        | `{boardId}`                                                            | `{users: [{id, name, isActive, pageId}], anonymousViewers}`; names capped at 64                                                                                                                                       | -                                                              | Yes                                     | Yes                             | Deferred; from room sessions                    |
| `create_board`           | `{name (<=200)}`                                                       | `{boardId, url}`                                                                                                                                                                                                      | limit reached                                                  | No: a host creates boards (its own MCP) | Yes, the account's limits apply | Deferred                                        |
| `rename_board`           | `{boardId, name}`                                                      | `{name, previousName}`                                                                                                                                                                                                | not owner                                                      | No (host)                               | Yes                             | Deferred                                        |
| `search_shapes` (ours)   | `{boardId, query (<=200), page?, source?: "native" \| "ocr", cursor?}` | `{matchCount, nextCursor?, matches: [{boardId, pageId, shapeId, excerpt (<=200), source: "native" \| "ocr", bounds: {x, y, w, h} in page coordinates, confidence (0-1; 1 for native)}]}`                              | not found                                                      | Yes                                     | Yes                             | Reserved                                        |

Differences from upstream, on purpose:

- `page` on `apply_ops` defaults to the first page instead of "whichever
  page the user has open": offline there is no open page. With multi-page
  boards an assistant should always pass the page id.
- No "open the board" refusals; none of the tools needs a tab except the
  account's own `get_user_state`.
- `search_boards` reports `access` per board.
- Not offered: comments, feedback, workspaces, any tool that runs code.

`search_shapes`: native matches come from `textOf` over records (shape
text, frame names, arrow labels) with bounds from our geometry. OCR matches
come from the image index the OCR evaluation proposes; each match's bounds
are the recognised word boxes mapped through the image shape's page
transform (crop and rotation included), so a match can be zoomed to. The
evaluation found exact-name recall of 56-80% and near zero on rotated map
lettering for most engines, so `confidence` and `source` are part of the
contract and OCR excerpts are doubly untrusted (wrong as well as
user-supplied).

## 11. Plan

Done since the last cut: the merge with `main`, the role model, both
Workers in CI.

| Phase | What                                                                                                                                                                                                                                                                                                                      | Days                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1     | Hosted authorization end to end: the first host's consent page listing boards where the member is manager or owner, tokens with `role`, the revocation call (`/rooms/<board>/mcp/revoke`), the reference host as an authorization server for e2e, the MCP Worker deployed at `mcp.<domain>`, tried with Claude and ChatGPT | 6 (plus the host's side) |
| 2     | Standalone authorization: verify AuthKit tokens (JWKS, issuer, audience), `assistant_clients` and `assistant_grants` in D1, the `/assistants` page (EN/PL), `grant_version` on boards, the Alchemy helper deploying the MCP Worker in standalone mode with the D1 binding                                                 | 7                        |
| 3     | Board names in the tabletop (§9c): title in the room, rename in the board's menu, the bootstrap `title` as a first suggestion, `create_board` and `rename_board`, the host's create endpoint in the reference host                                                                                                        | 5                        |
| 4     | Recent changes and undo-a-batch (§9b): the room's change log, attribution of people's pushes per session, inverse diffs for assistant batches, the list in the client, `undoBatch`                                                                                                                                        | 7                        |
| 5     | Screenshots: render page, internal render token, Cloudflare's headless browser, `get_cluster_screenshot` on upstream's sizing code; then the connected-tab fast path                                                                                                                                                      | 6 + 4                    |
| 6     | Presence tools: `get_board_users`, `get_user_state`, `{selected: true}` from the acting account's session (main's presence stamping names the person)                                                                                                                                                                     | 3                        |
| 7     | Hardening: page filter in SQL and snapshot deltas, rate limits per account and board, upstream's closed error vocabulary, "sized approximately" in op results, curved and elbow arrow ends and exact outlines in the stand-in                                                                                             | 5                        |
| 8     | `search_shapes` on the board's own index (typos, prefixes) and OCR matches when the image index exists                                                                                                                                                                                                                    | 2 + the OCR work         |

**About 45 days.** Order: 1 gives assistants on the first host; 3 and 4
are what the maintainer asked for by name; 2 when the standalone site
needs assistants; 5 to 8 as wanted.

## 12. Risks and unknowns

- **tldraw upgrades**: sizing constants, the arrow index rule and record
  shapes are restated from tldraw 5.6. The measurement harness and the
  record-equality e2e test are the tripwires; run `aube run e2e:measure`
  on every tldraw bump.
- **fontkit vs HarfBuzz** agree on this corpus; a text that hits a shaping
  difference would be off by a line. HarfBuzz as WASM is the exact
  alternative if it ever matters.
- **Two deploys that must agree**: the MCP Worker calls the room's
  document methods, so the board Worker must be deployed first when the
  contract grows, and a contract change must stay compatible for one
  deploy. The contract is two calls; keep it that way.
- **Soft dependencies** (§1a): a batch can overlap a shape that appeared
  while it was computed. Accepted; `untangle` and the result's `adjusted`
  notes are the remedy if it shows.
- **Snapshot size**: every call moves the page's records (2.8 MB for 5,000
  shapes). Fine at that size; the delta read is the plan beyond it.
- **Local development** needs one `wrangler dev` session for both Workers;
  separate processes could not call each other here (wrangler 4.145).
- **Font licences**: the embedded fonts are OFL (Shantell Sans, IBM Plex);
  embedding in a bundle is allowed, the notice must ship.
- **Client conflict on deleted records**, not exercised (§2).
- **Prompt injection**: framing reduces it, nothing removes it. `apply_ops`
  is marked destructive so clients ask; read-only grants are the real
  control.
- **Protocol drift**: the SDK is young (2.4.0); pin it and keep the two
  workerd tests.
- **Upstream drift**: the adapted code is tldraw's at commit `ebe1433`
  (their server version 3.10.0). Taking a later version is a re-copy and a
  16-line patch for the engine, as long as it asks the editor for nothing
  new; the inventory in §0 and tldraw's own tests are the check.
- **The permission is verbal**, and the maintainer has decided to ship on
  it. The adapted code is confined to
  `src/mcp/upstream/` and `test/mcp/upstream/`; without it the stand-in,
  the room contract and the MCP Worker remain, and the first spike's own
  engine is in the branch's history (`9834c55`).
- **The stand-in is a second implementation of editor behaviour.** It
  matches on every scenario tried; a tldraw upgrade can change a default
  prop or a sizing rule under it. `aube run e2e:fidelity` and
  `e2e:measure` on every tldraw bump are the tripwires.
- **WorkOS facts** in §9 need confirming against current documentation.

## 13. Open decisions

1. Role values: `"owner" | "manager" | "write"` as built, with `owner:
boolean` read for one more step. Confirm, and say when the flag goes.
2. Whether a manager, and not only the owner, may make other managers
   (built: owner only).
3. §9c: that the host keeps minting board ids (the MCP Worker asks it),
   and that the bootstrap `title` becomes a first suggestion only.
4. Standalone grants per client need `client_id` in AuthKit's token; if it
   is not there, grants per account, or wait for it.
5. Whether demoting a manager should end every assistant on the board
   (built: yes, the simple and safe reading) or only that person's.
6. Italic faces (+700 KB in the MCP Worker) and the "sized approximately"
   flag: now or later.

## 14. The merge with `main` (done)

`main` at `4465586` was merged into `mcp` with a merge commit.

| Conflict                         | Resolution                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `aube-lock.yaml` | Both sides' dependencies (main dropped the old dice library and added `minisearch`; this branch adds `fontkit`, `@modelcontextprotocol/server`, `zod`, `@tldraw/utils`); the lockfile regenerated by `aube install` |
| `src/board-room.ts`              | Both: main's avatars, presence stamping and roll seeds, and this branch's document interface and grant version. The room's record type is `TLRecord`                                                                |
| `e2e/playwright.config.ts`       | The hosted run keeps its three Worker configs (`dev/both.ts`) on the ports of `e2e/ports.ts`; the host's origin is written into the generated board config, because `--var` reaches only the first config           |

After the merge:

- Dice and rolls are not document records (rolls are the room's own table,
  the die is a toolbar icon), places and avatars are `meta` and presence:
  the room's schema is tldraw's default, and the stand-in needs nothing
  new.
- `search_shapes` uses the board's own folding, ranking and excerpts
  (`client/src/search-text.ts`, pure text code imported by the MCP
  Worker); the sheet's index (typos, prefixes) is not used server-side yet.
- The room contract's types moved to `src/room-contract.ts`, so the e2e
  type-check does not pull in Workers types.
- `e2e/tests/ops.spec.ts` and the measurement harness follow
  `E2E_PORT_OFFSET`.
- CI builds both Workers (`aube run build:workers`) and `aube run test`
  runs both Vitest projects.
- The tools take `page` as an index or an id; `apply_ops` defaults to the
  first page and its description asks for the id on boards with several.
- Open: the Alchemy helper deploys the MCP Worker in hosted mode only
  (type-checked, not deployed); tldraw's 4,000-shapes-a-page limit is
  enforced by the stand-in as by the client.
