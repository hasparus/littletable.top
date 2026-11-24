# Little Table

A shared whiteboard with dice for tabletop games. Everyone at the table
draws on one [tldraw](https://tldraw.dev) canvas. The server makes every
roll, and everyone sees the dice land the same way. Named places let you
jump around the board. It is built for phones first and installs to a home
screen. The package is `littletable-top`. This repository deploys it as
Little Table, at [littletable.top](https://littletable.top).

One Cloudflare Worker serves the React client (`client/`, built by Vite into
`dist/`) and the rooms. Each board is one SQLite-backed Durable Object,
`BoardRoom`, which runs a tldraw sync room and keeps the board's roll log.

Configuration picks one of two modes. In hosted mode a host application
owns accounts and boards and signs short-lived passes, and the tabletop
trusts one configured issuer ([docs/hosting.md](docs/hosting.md)). In
standalone mode the tabletop has its own domain, accounts (signed in
through WorkOS AuthKit) and boards, and signs its own passes. Guests join
by link with a name. Little Table runs standalone.

## Licence

No licence has been chosen for this repository's own code yet, and there is
no `LICENSE` file. The Outfit font in `client/src/theme/fonts/` is under the
SIL Open Font License (`OFL.txt` beside it). The text engines and their
models are under Apache-2.0 and MIT (see
[docs/internals.md](docs/internals.md#self-hosted-files)).

The tldraw SDK is an npm dependency under tldraw's own licence. Off
`localhost` it runs only with a licence key (`TLDRAW_LICENSE_KEY`). Under
the hobby licence Little Table uses, tldraw's "made with tldraw" mark must
stay visible, unobscured and clickable. Nothing on the board covers it, and
`e2e/tests/watermark.spec.ts` checks that at phone and desktop widths. A
host that deploys the tabletop brings its own key and licence terms.

## Layout

| Path                      | What                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `src/`                    | The Worker: routes, configuration, passes, the `BoardRoom` room                       |
| `client/`                 | The React client, its theme and icons; `client/settings.ts` holds its build settings  |
| `alchemy/`                | `Tabletop(...)`, the Alchemy helper that deploys the tabletop                         |
| `alchemy.run.ts`          | This repository's own standalone deployment                                           |
| `migrations/`             | The D1 schema of standalone mode                                                      |
| `test/`                   | The Vitest suite, run in workerd by the Workers pool                                  |
| `e2e/`                    | Playwright specs; `e2e/fake-host.ts` is a reference host; `e2e/fixtures/` .tldr files |
| `dev/dev-signing-key.pem` | A committed, throwaway key pair for laptops and tests; deploys refuse it              |

## Local development

Bun installs the packages and runs the scripts; Node runs the tools. Both
are pinned in `package.json`: Bun in `packageManager`, Node in
`devEngines.runtime`. Install those two versions, then `bun install`.

Run Alchemy through the `plan:*` and `deploy:*` scripts or
`./node_modules/.bin/alchemy`. `bun run alchemy` runs the `alchemy/` folder
and exits 0. `bunx alchemy` runs it under Bun, which Alchemy refuses.

| Command                                     | Does                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `bun run dev` and `bun run dev:worker`      | Vite on :8788 with hot reload, the Worker on :8789      |
| `bun run build && bun run serve`            | The built client from the Worker on :8788, real headers |
| `bun run test`                              | The Vitest suite in workerd, against `test/assets`      |
| `bun run e2e`                               | Playwright, against Workers it builds and starts itself |
| `bun run typecheck`, `lint`, `format:check` | The rest of what CI checks                              |

A laptop's build is a hosted client of `TABLETOP_HOST_ORIGIN` (default
`http://localhost:8000`, where `node e2e/fake-host.ts` runs a reference
host), and `wrangler dev` trusts the dev key from `.dev.vars`. For
standalone mode, build with `TABLETOP_MODE=standalone`, run
`node e2e/fake-workos.ts`, apply `wrangler d1 migrations apply DB --local`,
and start `wrangler dev --env-file e2e/standalone.env`. The e2e config does
the same on :8790.

`bun run e2e` starts four servers: :8000 (fake host), :8001 (fake WorkOS),
:8788 (hosted) and :8790 (standalone). With `CI` unset it reuses any already
listening there. A second checkout on the same machine sets
`E2E_PORT_OFFSET` (a multiple of 10, say `100`) to move all four. With
`SHOTS_DIR` set, the specs save screenshots of the states they reach.

## Deploys

`.github/workflows/deploy.yml` deploys Little Table (`alchemy.run.ts`) after
the CI checks (`ci.yml`) pass:

- every push to `main` deploys stage `prod`, on `littletable.top`;
- "Run workflow" deploys the stage it is given: `staging` (on
  `staging.littletable.top`), `prod` (only from `main`), or a preview name
  (lowercase letters, digits and hyphens), which gets its own Worker, D1
  database and R2 bucket on workers.dev.

The deploy runs `./node_modules/.bin/alchemy deploy --stage <stage> --yes`.
Each stage gets the Worker with the client as static assets, the
`BoardRoom` and `Limiter` Durable Objects, the D1 database with
`migrations/` applied, the R2 bucket of the boards' images, and the custom
domain. The Workers are `littletable` and `littletable-staging`. A bucket
with images in it is never destroyed with its stage, so empty a preview's
by hand.

One deploy per stage runs at a time. While an Environment lacks a required
input, a deploy to it changes nothing and ends green with a notice that
lists what is missing.

### GitHub Environments

Settings, Environments: `production` for `prod`, and `staging` for
`staging` and every preview. Give `production` a deployment branch rule for
`main`.

| Kind     | Name                    | Value                                                                                           |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| secret   | `CLOUDFLARE_API_TOKEN`  | The token below                                                                                 |
| variable | `CLOUDFLARE_ACCOUNT_ID` | The account's id (the dashboard's URL, or Workers & Pages, Account details)                     |
| secret   | `WORKOS_API_KEY`        | The WorkOS environment's API key (`sk_...`)                                                     |
| variable | `WORKOS_CLIENT_ID`      | That environment's client id                                                                    |
| secret   | `TABLETOP_SIGNING_KEY`  | A key of this Environment's own: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` |
| variable | `TLDRAW_LICENSE_KEY`    | Optional to deploy, but boards do not work without it. Public by design                         |

All but `TLDRAW_LICENSE_KEY` are required. Use WorkOS's staging environment
for `staging` and its production one for `production`. A tldraw licence key
is tied to domains, so get one that covers every host the Environment
deploys to. The workflow sets `TABLETOP_DOMAIN` to `littletable.top`.

### Cloudflare API token

My Profile, API Tokens, Create Custom Token, for the account the tabletop
deploys to:

| Scope                           | Permission               | For                                                                                       |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| Account                         | Workers Scripts: Edit    | The Worker, its assets, `BoardRoom` and `Limiter`, workers.dev, the state store's Worker  |
| Account                         | D1: Edit                 | The database, and its migrations, which Alchemy applies on each deploy                    |
| Account                         | Workers R2 Storage: Edit | The bucket of the boards' images, made on the first deploy and bound to the Worker        |
| Account                         | Secrets Store: Edit      | The state store's token and encryption key (read alone is not enough: Alchemy binds them) |
| Zone: the `TABLETOP_DOMAIN` one | Zone: Read               | Finding the zone of a custom domain                                                       |
| Zone: the `TABLETOP_DOMAIN` one | Workers Routes: Edit     | Attaching the custom domain                                                               |
| Zone: the `TABLETOP_DOMAIN` one | DNS: Edit                | The DNS record the custom domain gets                                                     |

The `littletable.top` zone must be on Cloudflare DNS in the same account.
Alchemy keeps its deploy state in the account's state store, a Worker named
`alchemy-state-store`. The first deploy creates it (and the Secrets Store,
if there is none); an account that already has one reuses it.

### WorkOS redirects

In the WorkOS environment of each stage, before anyone signs in, add
`https://<host>/auth/callback` as a redirect URI and `https://<host>/` as a
sign-out redirect. `prod` is `littletable.top` and `staging` is
`staging.littletable.top`. Register a preview's workers.dev host too.

## More

- [docs/hosting.md](docs/hosting.md): the host contract (configuration,
  the pass request, passes, routes) and deploying from a host's own stack.
- [docs/internals.md](docs/internals.md): images, avatars, text in images
  and its stored format, .tldr files, dice determinism, standalone mode's
  data, sessions and routes.
- Issues track what is left; #11 is the status page.
