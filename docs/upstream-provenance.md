# Upstream provenance

What on branch `mcp` was written with tldraw's code open beside it, and
under which terms. Nothing was copied or adapted from tldraw's hosted-app
code: no source, no tests, no description texts. Tool names, field names,
the op vocabulary, enums, limits and result shapes match on purpose, so an
assistant that knows tldraw's board tools knows ours.

Upstream studied: `tldraw/tldraw` at `ebe1433` (SDK 5.6.2); this repository
depends on tldraw 5.6.0.

## Hosted-app code: no licence grant, read as reference only

Read through the study in the maintainer's notes (tool schemas, limits and
behaviour quoted there) to learn the contract. Our schema
(`src/ops/schema.ts`), engine (`src/ops/`), clustering
(`src/ops/clusters.ts`), MCP server (`src/mcp/`), messages and tool
descriptions are our own.

| Upstream file                                                                                                                                                   | What we took from it                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dotcom/sync-worker/src/routes/tla/boardTools.ts`                                                                                                          | Tool names, input field names, result field names, size caps (ops 1-1000 and 1 MiB, runId 200, page sizes 40K/60K, screenshot 64-2560), the one-message rule for not-found and no-access                                          |
| `apps/dotcom/sync-worker/src/routes/tla/mcpServer.ts`                                                                                                           | That it serves protocol revisions 2026-07-28 and 2025-11-25 and hand-writes JSON-RPC (we use the official SDK instead)                                                                                                            |
| `apps/dotcom/sync-worker/src/routes/tla/mcpTabRender.ts`, `src/tabRenderBroker.ts`, `src/utils/tabRenderJobIds.ts`, `TLFileDurableObject.ts` (tab render parts) | How upstream relays to a browser tab, which we decided not to do; the broker idea is noted for the optional screenshot fast path                                                                                                  |
| `apps/dotcom/client/src/tla/utils/canvas-ops/schema.ts`, `packages/dotcom-shared/src/canvasOpsJsonSchema.ts`                                                    | Op names, field names, enums, value limits, reference forms, result shape                                                                                                                                                         |
| `apps/dotcom/client/src/tla/utils/canvas-ops/ops.ts`, `actions.ts`, `pathGeometry.ts`, `receiver.ts`, `ops.test.ts`                                             | Behaviour as described in the study only: per-op failure, a clearance of 20 px around shapes, lines and strokes not being obstacles, `meta.agent` on created shapes. Our placement, routing and reference code were designed here |
| `apps/dotcom/client/src/tla/utils/tabRender.ts`, `apps/dotcom/client/src/utils/boardCapture.ts`                                                                 | Screenshot limits (8x enlargement) for the deferred contract                                                                                                                                                                      |
| `packages/dotcom-shared/src/shapeClusters.ts`, `mcpPageRead.ts`                                                                                                 | The result shape of page and cluster info. Our clustering is a different method (grid neighbourhood with a page-relative reach, arrows as joins, word scoring)                                                                    |
| `apps/dotcom/sync-worker/src/routes/tla/headlessShadow.ts`                                                                                                      | That upstream compares a headless measurer with tabs on staging only                                                                                                                                                              |

## tldraw SDK (tldraw licence): a dependency, read to match its behaviour

Not vendored, not modified. Read from `node_modules` so that records the
server writes are the ones the editor would have written; the logic is
restated in our own code with the constants needed.

| Upstream file                                                                                        | Used for                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/tldraw/src/lib/shapes/shared/default-shape-constants.ts`                                   | Font sizes per size style, label padding, stroke sizes (`src/ops/text/sizing.ts`) |
| `packages/tldraw/src/lib/shapes/geo/GeoShapeUtil.tsx`                                                | How a geo label is measured and when `growY` and width change                     |
| `packages/tldraw/src/lib/shapes/note/NoteShapeUtil.tsx`                                              | Note size, the font-size adjustment loop, default props                           |
| `packages/tldraw/src/lib/shapes/text/TextShapeUtil.tsx`                                              | Text shape size and default props                                                 |
| `packages/tldraw/src/lib/shapes/arrow/ArrowShapeUtil.tsx`, `curved-arrow.ts`                         | Arrow default props; which side a bend curves to                                  |
| `packages/tldraw/src/lib/bindings/arrow/ArrowBindingUtil.ts`                                         | Where tldraw parents and orders a bound arrow, so no browser moves ours           |
| `packages/tldraw/src/lib/shapes/shared/defaultFonts.tsx`, `utils/static-assets/assetUrls.ts`         | Which font file backs which family and weight                                     |
| `packages/tldraw/src/lib/utils/text/richText.ts`                                                     | What counts as empty rich text                                                    |
| `packages/editor/src/lib/editor/managers/TextManager/TextManager.ts`, `editor.css`                   | The measuring element's box model and line height                                 |
| `packages/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts`                              | Base font size, line height, stroke width                                         |
| `packages/editor/src/lib/editor/Editor.ts`                                                           | That shape `onBeforeCreate`/`onBeforeUpdate` do not run for remote records        |
| `packages/sync-core/src/lib/TLSocketRoom.ts`, `TLSyncRoom.ts`, `TLSyncClient.ts`, `TLSyncStorage.ts` | `updateStore` and storage transactions, how external writes reach clients         |

## MIT packages: used as libraries

`@tldraw/tlschema` (record types, validators, `toRichText`, `b64Vecs`,
id helpers), `@tldraw/utils` (index keys), and through them
`@tldraw/store` and `@tldraw/validate`. Imported, not copied; their
licence files ship in `node_modules`.

`apps/mcp-app` (MIT) was read in the study and not used.

## Other third-party material

- fontkit 2.0.4 (MIT) shapes text; `@modelcontextprotocol/server` 2.4.0
  and zod 4 serve MCP.
- `src/ops/text/font-data.generated.ts` embeds eight font files from
  `@tldraw/assets` 5.6.0: Shantell Sans and IBM Plex, both under the SIL
  Open Font License 1.1. TODO: ship the two OFL notices beside it before
  this leaves the spike.
