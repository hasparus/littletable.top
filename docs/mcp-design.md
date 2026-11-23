# Assistants on the board: the MCP server and the server-side ops engine

Status: design and spike, branch `mcp`. What is built is marked **built**;
everything else is a plan. Numbers were measured on this branch (tldraw
5.6.0, workerd from wrangler 4.145, Node 26 for timings) unless a source is
named.

## 1. Decision

**Go: a pure, server-side operations engine inside the board's Durable
Object.** It reads the room's records, computes with our own geometry and
text measurer, validates every record against `@tldraw/tlschema`, and writes
one storage transaction, which the sync room sends to connected browsers as
one patch. No browser tab is involved, so a board nobody has open behaves
exactly like an open one. Upstream's hosted tools relay to the user's tab
and refuse without one; we do not copy that architecture.

The risky part was text. It is solved to the pixel for tldraw's own fonts
(§3): 100% of line counts, heights, geo `growY`, note `growY` and note font
adjustments match Chrome for Latin and Polish text in all four families and
four sizes; widths are within 1.6 px. What a server cannot know is the
reader's system fallback font for glyphs tldraw's fonts lack (CJK, emoji);
those are estimated and flagged.

What runs where:

| Concern                                   | Where                                                             |
| ----------------------------------------- | ----------------------------------------------------------------- |
| MCP transport, token check, tool schemas  | The Worker (`src/mcp/`), stateless, a fresh server per request    |
| Ops engine, clustering, run memory, audit | The board's Durable Object (`src/ops/`, `BoardRoom.mcpApplyOps`)  |
| Text measurement                          | The Durable Object: fontkit + tldraw's woff2 files, in the bundle |
| Delivery to open tabs                     | tldraw sync, unchanged (a storage transaction is broadcast)       |
| Screenshots (later)                       | A connected tab when one exists, else Browser Run (§7)            |
| Selection and viewport (`get_user_state`) | Presence records of the account's own session, when connected     |

## 2. What the slice proves, and what it does not

**Built and tested** (`aube run test`: 142 tests; `aube run e2e`):

- `apply_ops` with `add` (label, note, box, ellipse, any geo; fitted to its
  text; `at`, or `relation`/`gap`/`align` beside a target with collision
  avoidance), `connect` (bound arrow, labelled, routed around shapes),
  `label` (text by a shape, optional arrow), `rename` (with `fit`), `remove`
  (arrows that lose an end stay put). References by id, `{text}`,
  `{created}`; run memory in the Durable Object's SQLite, so `{created}`
  works across calls with nobody connected.
- The full op vocabulary as our own zod schema (`src/ops/schema.ts`): the
  other six ops validate and answer "not supported yet" per op.
- Executed against a real `BoardRoom` in the Workers pool with no session
  (`test/ops/apply-ops.test.ts`), and through the MCP endpoint
  (`test/mcp/mcp.test.ts`).
- Playwright (`e2e/tests/ops.spec.ts`): a member's open tab shows the shapes
  without a reload; every label fits inside its shape in the real browser;
  after a reload the room's shape and binding records are byte-for-byte
  what the server wrote (no browser re-parented or re-indexed an arrow, or
  re-measured a label). Screenshots: `ops-live.png`, `ops-reloaded.png`.
- MCP endpoint with `tools/list` and tool calls in workerd, both protocol
  eras, behind a board-scoped RS256 access token with a per-board grant
  version.
- Page clusters from records (`src/ops/clusters.ts`), not yet a tool.

**Not proven:**

- `place`, `restyle`, `resize`, `duplicate`, `untangle`, `path`;
  `{description}` and `{selected}` references.
- Arrow labels as obstacles. In the screenshot the "Old well" label sits on
  the course of an earlier arrow, and "two days" is cramped on an arrow 40 px
  long. Labels and arrows must become obstacles for `label`, and `connect`
  must report a label that does not fit its arrow.
- Frames as placement context (a shape placed beside one inside a frame
  stays on the page), rotated targets (handled as their page-axis box),
  groups as targets.
- A client editing a shape at the moment the server removes it. The room
  rebases pushes on server state; what a pending client `put` does to a
  record the server deleted was not exercised.
- Standalone mode has no MCP endpoint yet (§8).
- Real ChatGPT and Claude clients against the endpoint (needs a deployed
  authorization server).

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
x 4 sizes = 368 cases in four browsers. `test/ops/text-measure.test.ts`
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

| Item                                                                    | Number                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| Worker bundle before the spike                                          | 602 KiB, 122 KiB gzip                                |
| With measurer (fontkit + 8 faces) and MCP SDK + zod + engine            | 3207 KiB, 1152 KiB gzip                              |
| of which fontkit + fonts                                                | about 1.4 MiB raw, 720 KiB gzip                      |
| First measurement per family (woff2 decode and parse), once per isolate | draw 140-200 ms; sans 36-56; serif 21-33; mono 18-22 |
| A label whose words were seen before                                    | 0.13 ms                                              |
| A label of three unseen words                                           | 2.3 ms                                               |

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
- NOTE: `TLSocketRoom.updateStore` is deprecated in 5.6 and copies every
  record on each call (54 ms for 8,000 records). The engine uses
  `room.storage.transaction` and validates itself.

### Concurrency and failure

- A Durable Object runs one event at a time and the engine is synchronous,
  so a batch reads and writes with nothing in between. One storage
  transaction is one broadcast: the test shows a connected session
  receiving a 3-op batch (5 records) as a single patch.
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

## 5. Remaining ops and contract: effort

One person, including tests and e2e, on top of the slice.

| Item                                                                                             | Days         |
| ------------------------------------------------------------------------------------------------ | ------------ |
| `place` (move, resize, retext, restyle one shape; reuses add/rename)                             | 1.5          |
| `restyle` with `like`                                                                            | 0.5          |
| `resize` (`w`/`h`/`scale`, anchor, label refit; notes scale)                                     | 1            |
| `duplicate` (with children, bindings between copies)                                             | 1            |
| `path` (line shape; `closed` as a draw or geo polygon; `smooth`)                                 | 1.5          |
| `untangle` (overlap removal with `keepNear`, `maxDistance`)                                      | 2.5          |
| `{description}` references (colour, kind, label, region words)                                   | 1.5          |
| `{selected}` from the account's presence                                                         | 0.5          |
| Labels and arrows as obstacles; arrow label fit; frames as parents; ellipse and diamond outlines | 3            |
| Result contract polish (`adjusted` texts, approximate-size flag, undo-a-batch)                   | 1.5          |
| Multi-page: page by id everywhere, moving across pages refused                                   | 0.5          |
| **Total**                                                                                        | **about 15** |

`untangle` and the obstacle work are where estimates can slip: they are
layout heuristics judged by eye.

## 6. Page inspection (`get_page_info`, `get_cluster_info`)

Both are computable from records and our geometry; nothing needs a tab.
Our algorithm (`src/ops/clusters.ts`, built; the tools are not):

1. An atom is a top-level shape with everything inside it.
2. An arrow joins the atoms it is bound to.
3. Atoms whose boxes are closer than `reach` join; `reach` is half the
   median atom's shorter side, between 40 and 160 px. A grid of
   `reach`-sized cells finds neighbours in about linear time; arrows are
   left out of the grid so a long arrow does not chain distant groups.
4. Keywords are the words frequent in the cluster and rare across the
   page's clusters; the label is the top three; the id is a hash of the
   member ids, so it is stable until membership changes.

Cost: 180 ms for 5,000 shapes once boxes are known (table above), well
inside one request. `get_cluster_info` is a lookup plus serialisation with
the 60K-character cap and a cursor. To add: paging at 40K characters,
handwriting reported as "N strokes" (only a screenshot shows it), and a
containment rule for large background images (a map under tokens should
not swallow the page into one cluster; treat a shape covering more than
half the page box as a backdrop).

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

The host is the OAuth 2.1 authorization server. The tabletop Worker is a
protected resource.

```
Assistant client            Tabletop Worker (resource)        Host (authorization server)     Board DO
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
> | `MCP_AUTHORIZATION_SERVER` | The host's authorization server (issuer origin). Setting it serves `/mcp`                                |
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

Built: the two variables, token verification, `/.well-known` metadata, the
grant version check and `BoardRoom.revokeMcpGrants`. Not built: the
`/mcp/revoke` route and anything on a host.

### Standalone mode (design)

|                           | (a) WorkOS AuthKit as the authorization server                                                                                                                                                                    | (b) `@cloudflare/workers-oauth-provider` in the Worker, WorkOS for sign-in only               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Standards                 | CIMD, DCR, PKCE, resource indicators handled by WorkOS                                                                                                                                                            | The library implements the endpoints, DCR and CIMD, PKCE; tokens stored hashed in KV          |
| Per-board consent         | No: scopes are fixed and its consent screen is its own. Board choice would be a second step of ours after the OAuth flow (a "connect this assistant" page), with tokens that are valid before any board is chosen | Yes: our own consent page, inside the flow, lists the account's boards with off / read / edit |
| Token contents            | WorkOS's JWT; board grants live in our D1 and are looked up per call                                                                                                                                              | Opaque token; the grant (boards, access, grant versions) is the token's stored props          |
| Revocation                | Ours in D1 for boards; WorkOS for the client                                                                                                                                                                      | Ours entirely: delete the grant, or raise a board's grant version                             |
| Coupling                  | Ties MCP to one identity vendor's product decisions; the provider seam in `src/standalone/provider.ts` stops being the only WorkOS touchpoint                                                                     | WorkOS stays behind the existing seam; needs a KV namespace                                   |
| Same shape as hosted mode | No (two-step)                                                                                                                                                                                                     | Yes (one consent, per-board grants, grant versions)                                           |

**Recommendation: (b).** The product promise is "you choose which boards
this assistant sees", and only (b) puts that choice in the authorization
step. It also keeps one model across modes: in both, the room sees a board
grant with an access level and a grant version. (WorkOS's MCP feature set
is stated from its documentation as I know it; confirm before ruling (a)
out on facts.)

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

| Phase | What                                                                                                                                                                               | Days                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0     | Bring the branch onto current `main`: multi-page (page ids in ops and tools), configurable e2e ports, `BoardRoom` and `index.ts` merges, the project's new name in the server info | 2                        |
| 1     | Read tools: `get_page_info`, `get_cluster_info`, `search_boards` paging, `get_board_users`; backdrop rule; caps and cursors                                                        | 4                        |
| 2     | Hosted authorization end to end with the first host: consent page, tokens, `/mcp/revoke`, e2e against the reference host; try with Claude and ChatGPT                              | 5 (plus the host's side) |
| 3     | Remaining ops and references (§5)                                                                                                                                                  | 15                       |
| 4     | Screenshots through Browser Run with an internal render token; then the connected-tab fast path                                                                                    | 6 + 4                    |
| 5     | Standalone authorization server (`workers-oauth-provider`, consent page, grants in D1/KV), `create_board`, `rename_board`                                                          | 7                        |
| 6     | `get_user_state`, undo-a-batch, "Assistant" in the People sheet, rate limits per account and board                                                                                 | 4                        |
| 7     | `search_shapes` native, then OCR when the index exists                                                                                                                             | 2 + OCR work             |

Order: 0, 1, 2 give a useful read-and-annotate assistant on the first
host; 3 can run in parallel with 2.

## 12. Risks and unknowns

- **tldraw upgrades**: sizing constants, the arrow index rule and record
  shapes are restated from tldraw 5.6. The measurement harness and the
  record-equality e2e test are the tripwires; run `aube run e2e:measure`
  on every tldraw bump.
- **fontkit vs HarfBuzz** agree on this corpus; a text that hits a shaping
  difference would be off by a line. HarfBuzz as WASM is the exact
  alternative if it ever matters.
- **Bundle size** grew 9x gzip (122 KiB to 1.15 MiB); cold starts of the
  Worker and of each Durable Object pay for parsing it. Splitting MCP into
  its own Worker with a service binding is possible; the engine must stay
  with the room.
- **Font licences**: the embedded fonts are OFL (Shantell Sans, IBM Plex);
  embedding in a bundle is allowed, the notice must ship.
- **Client conflict on deleted records**, not exercised (§2).
- **Prompt injection**: framing reduces it, nothing removes it. `apply_ops`
  is marked destructive so clients ask; read-only grants are the real
  control.
- **Protocol drift**: the SDK is young (2.4.0); pin it and keep the two
  workerd tests.
- **Upstream contract drift**: tool names and shapes follow tldraw's hosted
  tools at commit `ebe1433`; they version theirs (3.10.0) and will change.
- **WorkOS facts** in §9 need confirming against current documentation.

## 13. Decisions needed

1. Accept the bundle and cold-start cost of server-side text measurement
   (1.15 MiB gzip), or split MCP transport into a second Worker.
2. Screenshots: Browser Run as the offline renderer (a paid-plan feature
   with a small monthly cost), with the connected tab as a fast path.
3. Standalone authorization: our own authorization server in the Worker
   (recommended) or WorkOS AuthKit with a second board-picking step.
4. Hosted contract: the token and revocation shape in §9, and whether the
   first host adds the consent page now.
5. Whether `create_board` / `rename_board` exist in hosted mode at all, or
   stay with the host's own MCP server.
6. Italic faces (+700 KB) and the "sized approximately" flag: ship now or
   when someone notices.
7. Undo for assistant batches: a tool, a button on the board, or both.
