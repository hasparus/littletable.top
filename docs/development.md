# Local development

Install the Bun and Node versions pinned in [package.json](../package.json).
Bun installs packages and runs scripts. Node runs Vite, Wrangler, Playwright
and Alchemy.

```sh
bun install
```

## Run a board locally

The default local build uses a sample host. Start each of these in a separate
terminal, then open the sample host at `http://localhost:8000` and create a board.

```sh
node e2e/fake-host.ts
bun run dev:worker
bun run dev
```

Vite serves the client with hot reload on port 8788 and proxies API requests
and WebSockets to the Worker on 8789. The client uses `TABLETOP_HOST_ORIGIN`
for the host. It defaults to the sample host. Wrangler uses a throwaway
signing key committed for local development and tests.

To serve the built client from the Worker, including its HTTP headers, stop the
Vite server and run `bun run build && bun run serve`. The Worker then listens
on port 8788.

### Standalone mode

Standalone mode has its own accounts and board list. Start the WorkOS
stand-in with `node e2e/fake-workos.ts` in a separate terminal, then run:

```sh
TABLETOP_MODE=standalone bun run build
./node_modules/.bin/wrangler d1 migrations apply DB --local
./node_modules/.bin/wrangler dev --env-file e2e/standalone.env
```

`e2e/standalone.env` configures the local Worker for the test identity provider.
The public board is at `/` and the account board list is at `/boards`.

## Tests

- `bun run test` runs Vitest against the Worker runtime.
- `bun run e2e` builds and starts both app modes and exercises them with Playwright.
- `bun run typecheck`, `bun run lint` and `bun run format:check` check the code.

Playwright starts the sample host on 8000, the WorkOS stand-in on 8001, the
hosted Worker on 8788 and the standalone Worker on 8790. Outside CI it reuses
servers already listening there. To test another checkout at the same time,
set `E2E_PORT_OFFSET` to a multiple of 10. Set `SHOTS_DIR` to save screenshots
from specs that capture their UI states.

## Source

- [client/](../client/) contains the React board and its theme.
- [src/](../src/) contains the Worker, board rooms and account APIs.
- [alchemy/](../alchemy/) contains the deployment helper. See [hosting](hosting.md)
  for its host contract.
- [migrations/](../migrations/) holds the standalone database schema.
- [test/](../test/) and [e2e/](../e2e/) contain the Worker and browser tests.
