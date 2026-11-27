# CLAUDE.md

- Work in PRs. Signed commits, no trailers. CI must pass: `typecheck`, `lint`, `format:check`, `build`, `test`.
- E2E: `E2E_PORT_OFFSET=<n> bun run e2e`; checkouts share ports. Never kill processes by pattern.
- Phone first: the bottom bar fits 360 px. All copy in English and Polish (`k6`, not `d6`).
- Dice simulation uses exact arithmetic only (`+ - * /`, `sqrt`, `abs`, `min`, `max`, `floor`, `imul`); changes move the tripwire hashes.
- No request leaves the origin. User text (chat, OCR) renders as text, never HTML.
- Keep tldraw's mark visible. No host application names, no `tl` prefix in our names.
- `src/mcp/upstream/` is tldraw's code: keep its formatting, log changes in `docs/upstream-provenance.md`.
- No lint or type suppressions. Comments only as `NOTE:`, `SAFETY:`, `HACK:`, `TODO:`.
- Tests: no tautologies or change detectors. E2E asserts on roles and accessible names.
