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

## PostHog in production

In the `production` GitHub Actions environment, set the Actions variable
`POSTHOG_WEB_PROJECT_TOKEN` to the public project token from
[PostHog project 768580](https://us.posthog.com/project/768580/settings/project).
In that project, enable Session Replay. Under Support → Settings, enable
Support and the in-app widget, then add `littletable.top` to Allowed domains.

After deploying, visit the homepage and the dice docs. In PostHog, confirm a
pageview in Web Analytics, a recording in Session Replay, and a test ticket
in Support. Error Tracking receives uncaught browser errors and unhandled
promise rejections from those pages. Source maps are not uploaded by this setup.

The SDK runs on the standalone homepage and dice docs. Replay masks the live
tabletop and Support widget, and disables network and console recording.
The board list and board menu open Support in a new tab at `/docs/?support`,
with the source page's referrer suppressed. New feedback goes to the Support
inbox. The board list, private board URLs, and preview deployments stay
outside browser capture.

### Discord notifications

Create an incoming webhook in the private Discord channel where the team
triages reports. Enter the webhook URL directly in PostHog.

- In Error Tracking → Configuration → Alerting, create a Discord notification
  for new and reopened issues. Use **Test function**, then enable the alert.
  [Error Tracking alerts](https://posthog.com/docs/error-tracking/alerts)
- In Workflows, use the `$conversation_message_received` event as the trigger.
  Add a Discord destination step and set **Allowed mentions** to **None**.
  Include the ticket number and a message excerpt in **Content** using
  `{event.properties.ticket_number}` and
  `{substring(event.properties.message_content, 0, 1500)}`.
  Test by submitting a ticket from the widget. Reply in the Support inbox.
  [Support event properties](https://posthog.com/docs/workflows/workflow-builder)
  · [Discord destination](https://posthog.com/docs/data-pipelines/destinations/discord)

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

## Preview database

The [Staging database workflow](../.github/workflows/staging-db.yml) provisions
`littletable-preview-accounts` and applies migrations from `main`. PR previews
share this non-production database. The staging app and production each keep
their existing databases and are outside this preview database. Preview
bundles carry the Worker and client assets. CI tests PR migrations, and the
shared preview schema changes after merge.

The preview stack scopes board records to each PR Worker, matching where its
whiteboard Durable Objects and files live. The shared database is a sandbox
for preview code from approved repository writers.

For rollout, let the staging database workflow finish before redeploying open
PR previews. A preview with saved boards stops before changing its binding.
Copy its board metadata into the shared database under the same `pr-N`
partition, retaining account IDs, board IDs, share codes, link versions and
visit records. Verify board access before retiring the legacy database.
Empty previews switch directly, with the old database retained for recovery
until an operator confirms the cutover and deletes it.

### MCP for previews

PR previews and the standalone staging deploy read GitHub Environment variables
from `preview`. Set `MCP_AUTHKIT_ORIGIN` to the staging WorkOS AuthKit issuer
origin and `MCP_DOMAIN` to a hostname such as `mcp.staging.littletable.top`.
PR 42 then serves MCP at `https://pr-42.mcp.staging.littletable.top/mcp` and
the standalone staging deploy uses `https://mcp.staging.littletable.top/mcp`.

In staging WorkOS, register the wildcard Resource Indicator
`https://pr-*.mcp.staging.littletable.top/mcp`. Register the standalone staging
URL separately if you use it. The preview comment links to the PR's MCP
endpoint when deployed. After connecting a client, sign in to the PR's board
site and choose which boards it can access in `/assistants`. Each MCP Worker
uses the same board partition as its preview site.

Production reads the same variable names from `production`, with its own
AuthKit issuer origin and exact MCP hostname. Register
`https://<production-mcp-hostname>/mcp` in production WorkOS. Enable Client ID
Metadata Documents or Dynamic Client Registration in each WorkOS environment
you use. [WorkOS MCP setup](https://workos.com/docs/authkit/mcp)
