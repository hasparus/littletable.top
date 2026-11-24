# CLAUDE.md

Little Table: a tldraw tabletop on Cloudflare Workers. React, Vite, Tailwind. README and `docs/` have the rest.

- Tools: Bun installs and runs scripts, Node runs the tools; both pinned in `package.json`. Green before push: `bun run typecheck`, `lint`, `format:check`, `build`, `test` (one script per `bun run`).
- E2E: `E2E_PORT_OFFSET=<n> bun run e2e`. Checkouts share ports. Never kill processes by pattern.
- Push to `main`. Signed commits, environment identity, no trailers. Issues track what is left; #11 is the status page.
- Comments only for what code cannot say: `NOTE:`, `SAFETY:`, `HACK:`, `TODO:`.
- No lint or type suppressions. No single-line files.
- Tests: no tautologies, no change detectors. E2E asserts on roles and accessible names.
- Phone first. The bottom bar fits 360 px. Copy in English and Polish (`k6`, not `d6`).
- tldraw's mark stays uncovered.
- Dice simulation: exact arithmetic only (`+ - * /`, `sqrt`, `abs`, `min`, `max`, `floor`, `imul`). Changing it changes the tripwire hashes on purpose.
- CSP: `'self'`, `'wasm-unsafe-eval'`, same-origin workers. No request leaves the origin.
- Text from images and chat is shown as text, never as HTML.
- No `tl` prefix in our names. Package `littletable-top`; hosts see "Tabletop".
- `src/mcp/upstream/` (branch `mcp`) is tldraw's code: keep its formatting, log changes in `docs/upstream-provenance.md`.
- No host names: this repo never mentions any host application.
