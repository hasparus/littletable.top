# tltabletop

A shared whiteboard with dice for tabletop games: a [tldraw](https://tldraw.dev)
canvas that everyone at the table draws on, a dice tray whose rolls the
server makes and everyone sees land the same, and named places to jump to.
Phone first; the board installs to a home screen.

One Cloudflare Worker serves the React client (`client/`, built by Vite into
`dist/`) and the rooms. Each board is one SQLite-backed Durable Object,
`BoardRoom`, which runs a tldraw sync room and keeps the board's roll log.

The tabletop runs in one of two modes, chosen by configuration:

- **Hosted.** A host application owns accounts and board records and signs
  short-lived passes; the tabletop trusts one configured issuer. The host
  contract below is everything a host implements.
- **Standalone.** The tabletop runs on a domain of its own, with its own
  accounts, and signs its own passes. _In progress; see "Standalone mode"._

No licence has been chosen for this repository yet. The Outfit font in
`client/src/theme/fonts/` is under the SIL Open Font License (`OFL.txt`
beside it); tldraw is an ordinary npm dependency under its own licence.

## Layout

| Path                      | What                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `src/`                    | The Worker: routes, configuration, passes, the `BoardRoom` room                      |
| `client/`                 | The React client, its theme and icons; `client/settings.ts` holds its build settings |
| `alchemy/`                | `Tabletop(...)`, the Alchemy helper a host deploys the tabletop with                 |
| `alchemy.run.ts`          | This repository's own standalone deployment                                          |
| `test/`                   | The Vitest suite, run in workerd by the Workers pool                                 |
| `e2e/`                    | Playwright specs; `e2e/fake-host.ts` is a reference host                             |
| `dev/dev-signing-key.pem` | A committed, throwaway key pair for laptops and tests; deploys refuse it             |

## The host contract (hosted mode)

### Worker configuration

The Alchemy helper sets these from its props; `wrangler.json` and
`.dev.vars` set them for `wrangler dev`.

| Variable            | Helper prop        | Meaning                                                                                                              |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `TABLETOP_MODE`     | `mode`             | `hosted`                                                                                                             |
| `ISSUER_PUBLIC_KEY` | `issuerPublicKey`  | The host's RSA public key, SPKI PEM (`\n` escapes allowed). Passes are RS256.                                        |
| `ISSUER`            | `issuer`           | The `iss` of the host's tokens. May not be `tabletop`, the standalone mode's own.                                    |
| `PASS_AUDIENCE`     | `passAudience`     | The `aud` of passes. Default `board`. May not be `tabletop-standalone`.                                              |
| `DELETION_AUDIENCE` | `deletionAudience` | The `aud` of deletion tokens. Default `board-deletion`; must differ from the pass's.                                 |
| `HOST_ORIGIN`       | `hostOrigin`       | The host's origin. The page's Content-Security-Policy allows it for the pass request.                                |
| `HOME_URL`          | `homeUrl`          | Where `GET /` redirects (302). Default `HOST_ORIGIN/`.                                                               |
| `PRIMARY_HOST`      | `domain.primary`   | The tabletop's own host. Empty: answer on any host (laptops, workers.dev previews).                                  |
| `ALIAS_HOSTS`       | `domain.aliases`   | Comma-separated hosts answered with a 308 to the same path and query on the primary host, before anything else runs. |

A configuration that misses what its mode needs, or sets the other mode's
variables (`SIGNING_KEY` in hosted mode), is refused: every request answers
500 "This tabletop is not configured" and the Worker logs
`tabletop.misconfigured` with the reason.

The client is built per deployment, from these helper props:

| Helper prop                               | Meaning                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostOrigin` + `bootstrapPath`            | The pass endpoint. Default path `/b/{code}/bootstrap/`, `{code}` the share code                                                                     |
| `exitUrl`                                 | Where "Back to the main page" leads before the host has answered. Default `hostOrigin/`                                                             |
| `displayName`, `shortName`, `description` | The page title, the home-screen name and the manifest. Default "Tabletop"                                                                           |
| `language`                                | `en` or `pl`, when neither `?lang=` nor the browser names one. Default `en`                                                                         |
| `brand`                                   | Up to six hex colours: `primary`, `primaryHover`, `primaryLight`, `primaryStrong` (text on the light wash), `primaryLightDark`, `primaryStrongDark` |
| `iconsDir`                                | A directory with `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-1024.png`, `icon-maskable-512.png`                    |
| `licenseKey`                              | tldraw's licence key. Public by design: tldraw ties it to the domain                                                                                |

### The pass request

The tabletop serves `GET /b/<share code>` (1-64 ASCII letters and digits).
The client takes its language from `?lang=` (and drops it from the address),
then the browser's, then the configured default. It then asks the host for a
pass:

```http
POST <HOST_ORIGIN>/b/<share code>/bootstrap/
Origin: <the tabletop's origin>
Content-Type: application/json
Cookie: <the host's session cookie; the request is made with credentials: "include">

{}                      (or {"name": "Bea"} once a guest has typed a name)
```

The host answers only the tabletop's origin, with
`Access-Control-Allow-Origin: <tabletop origin>`,
`Access-Control-Allow-Credentials: true` and `Vary: Origin`, and answers the
preflight (`OPTIONS`) with `Access-Control-Allow-Methods: POST` and
`Access-Control-Allow-Headers: Content-Type`. The JSON content type forces
that preflight, which is what stands in for a CSRF token. The cookie reaches
the host only when the two hosts are the same site (for example
`board.example.org` and `example.org`) and its `SameSite` allows it.

| Status | Body                                                                                                  | The client                                 |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | `{"pass", "board", "person": {"id", "name", "owner"}, "title", "home": {"name", "url"}, "boardsUrl"}` | opens the board                            |
| 422    | `{"error": "name-required"}`                                                                          | asks for a display name and sends it       |
| 422    | `{"error": "name-invalid"}`                                                                           | asks again, saying the name cannot be used |
| 403    | `{"error": "link-reset"}`                                                                             | says the link was reset                    |
| 404    | anything                                                                                              | says the board no longer exists            |
| 429    | anything                                                                                              | says to wait a minute                      |
| other  | anything                                                                                              | says it could not open the board; retry    |

In the 200 answer, `board` is the board's id (its room is `/rooms/<board>`),
`person.id` is the pass's `sub`, `title` becomes the page title, `boardsUrl`
is where a member's board list is (`null` for a guest), and `home` is where
a guest leaves to ("Back to <home.name>"). A member's way out is "My
boards".

The client asks again, with the same request, before its pass is four
minutes old and whenever its socket reconnects. A 404 then ends the board
("no longer exists"), and `name-required` ends it as a reset link.

### Passes

A pass is an RS256 JWT the host signs for one person on one board:

| Claim        | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| `iss`        | `ISSUER`                                                       |
| `aud`        | `PASS_AUDIENCE`                                                |
| `sub`        | The person's id; one that starts with `g:` is shown as a guest |
| `board`      | The board's id, `[A-Za-z0-9_-]{1,64}`                          |
| `link`       | The board's link version, an integer from 0                    |
| `name`       | The display name, 1-40 characters                              |
| `owner`      | Whether the person owns the board                              |
| `iat`, `exp` | Required. The reference host gives five minutes                |

The pass travels in the request (`?pass=` on the socket, `Authorization:
Bearer` elsewhere), never in a cookie. A pass with a higher `link` than the
board has seen moves the board on and closes every connection that came in
with a lower one; a pass with a lower `link` is refused. A host resets a
board's link by giving it a new share code and signing later passes with
`link + 1`.

A **deletion token** is a JWT with `aud` = `DELETION_AUDIENCE`, the same key
and issuer, and the claims `board` and `exp`. The host sends it server to
server: `POST /rooms/<board>/delete` with `Authorization: Bearer <token>`,
answered 204, repeatable. A pass cannot delete, and a deletion token cannot
open a socket or roll. Deleting closes the board's connections, then removes
the tldraw document, the roll log and the link version; the same id starts
again from link version 0.

### Routes

| Route                        | Does                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `GET /b/<share code>`        | The client's shell                                        |
| `GET /`                      | 302 to `HOME_URL`                                         |
| `GET /<file>`                | The built client: scripts, styles, fonts, manifest, icons |
| `GET /rooms/<board>/connect` | The tldraw sync socket (`?sessionId=&pass=`)              |
| `POST /rooms/<board>/roll`   | Rolls `{"dice": [6, 6]}` for everyone                     |
| `GET /rooms/<board>/rolls`   | The latest 50 rolls                                       |
| `POST /rooms/<board>/delete` | Deletes the board's data (deletion token)                 |

The rooms API is same-origin with the client and sends no CORS headers. The
room draws every die (d4 d6 d8 d10 d12 d20 d100, up to 20 at once, one roll
per person per 500 ms) and sends the roll to each connection as a tldraw
sync custom message, so no client can edit one.

A socket whose pass is valid but must be refused is accepted and closed at
once with code 4099, which tldraw treats as final; `useSync` reports a
`TLRemoteSyncError` with the reason:

| Why                                   | Close reason |
| ------------------------------------- | ------------ |
| The link was reset (older version)    | `FORBIDDEN`  |
| The board is full (30 people)         | `ROOM_FULL`  |
| The board was deleted while connected | `NOT_FOUND`  |

A missing, invalid or wrong-board pass is a plain 403. `roll` and `rolls`
answer 403 for a reset link and 429 for a roll that comes too fast.

Every page and file leaves with the tabletop's Content-Security-Policy
(`default-src 'none'`; scripts, styles and fonts from itself; the rooms
socket; the host's origin) and the usual hardening headers.

## Deploying it from a host's stack

A host's own `alchemy.run.ts`, with this package installed:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Tabletop } from "tltabletop/alchemy";

export default Alchemy.Stack(
  "Host",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const root = yield* Config.String("HOST_DOMAIN");
    const board = yield* Tabletop("Board", {
      mode: "hosted",
      domain: { primary: `board.${root}`, aliases: [`vtt.${root}`] },
      issuer: "my-host",
      issuerPublicKey: yield* Config.String("BOARD_ISSUER_PUBLIC_KEY"),
      hostOrigin: `https://${root}`,
      homeUrl: `https://${root}/boards/`,
      displayName: "My Host Board",
      brand: { primary: "#f85a3c", primaryHover: "#e53e20" },
      language: "pl",
      licenseKey: yield* Config.String("TLDRAW_LICENSE_KEY"),
    });
    return { boardUrl: board.url };
  }),
);
```

`Tabletop(id, props)` builds the client into `.alchemy/tabletop/<id>/` with
these settings and declares the Worker (this package's `src/index.ts`,
bundled by Alchemy), the `BoardRoom` Durable Object and the custom domains.
It refuses the committed dev key. `alchemy`, `@alchemy.run/cloudflare` and
`effect` are peer dependencies, so the host's stack and the helper share one
copy of each. The helper is plain JavaScript (`alchemy/index.js` with a
hand-written `index.d.ts`) because Alchemy's loader does not transpile
TypeScript under `node_modules`.

### As a dependency

The package is `tltabletop`; nothing is published yet.

- **Git dependency**, which works today:
  `"tltabletop": "github:hasparus/tltabletop#<commit>"`. The repository is
  private, so the host's install needs a token that can read it. No build
  runs at install; the helper builds the client at deploy time.
- **Registry package**: drop `"private": true`, choose a licence (and a
  scope if the name is taken), and publish; `files` in `package.json`
  already lists what a deploy needs.

## Local development

Tools come from `mise.toml` (Node and aube): `mise install`, then
`aube install`.

| Command                                      | Does                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `aube run dev` and `aube run dev:worker`     | Vite on :8788 with hot reload, the Worker on :8789      |
| `aube run build && aube run serve`           | The built client from the Worker on :8788, real headers |
| `aube run test`                              | The Vitest suite in workerd, against `test/assets`      |
| `aube run e2e`                               | Playwright, against Workers it builds and starts itself |
| `aube run typecheck`, `lint`, `format:check` | What CI checks besides                                  |

A laptop's build is a hosted client of `TABLETOP_HOST_ORIGIN` (default
`http://localhost:8000`, where `node e2e/fake-host.ts` runs a reference
host), and `wrangler dev` trusts the dev key from `.dev.vars`.

## Standalone mode

Being built: accounts through a sign-in provider, a "My boards" list of
created and visited boards, and guests who join by link with a display
name, as in hosted mode. `alchemy.run.ts` deploys this repository's own
standalone copy (stages `prod` and `staging`, any other stage a workers.dev
preview) on `TABLETOP_DOMAIN`.
