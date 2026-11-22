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
  accounts (signed in through WorkOS AuthKit) and boards, and signs its
  own passes; guests join by link with a name. See "Standalone mode".

No licence has been chosen for this repository yet. The Outfit font in
`client/src/theme/fonts/` is under the SIL Open Font License (`OFL.txt`
beside it); tldraw is an ordinary npm dependency under its own licence.

## Layout

| Path                      | What                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `src/`                    | The Worker: routes, configuration, passes, the `BoardRoom` room                       |
| `client/`                 | The React client, its theme and icons; `client/settings.ts` holds its build settings  |
| `alchemy/`                | `Tabletop(...)`, the Alchemy helper a host deploys the tabletop with                  |
| `alchemy.run.ts`          | This repository's own standalone deployment                                           |
| `test/`                   | The Vitest suite, run in workerd by the Workers pool                                  |
| `e2e/`                    | Playwright specs; `e2e/fake-host.ts` is a reference host; `e2e/fixtures/` .tldr files |
| `dev/dev-signing-key.pem` | A committed, throwaway key pair for laptops and tests; deploys refuse it              |

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
Bearer` elsewhere). The one exception is reading a board's images, which
an `<img>` does with the pass in a cookie scoped to that board's files
(see "Images"). A pass with a higher `link` than the
board has seen moves the board on and closes every connection that came in
with a lower one; a pass with a lower `link` is refused. A host resets a
board's link by giving it a new share code and signing later passes with
`link + 1`.

A **deletion token** is a JWT with `aud` = `DELETION_AUDIENCE`, the same key
and issuer, and the claims `board` and `exp`. The host sends it server to
server: `POST /rooms/<board>/delete` with `Authorization: Bearer <token>`,
answered 204, repeatable. A pass cannot delete, and a deletion token cannot
open a socket or roll. Deleting closes the board's connections, then removes
the tldraw document, the roll log, the link version and the board's images;
the same id starts again from link version 0.

### Routes

| Route                               | Does                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `GET /b/<share code>`               | The client's shell                                        |
| `GET /`                             | 302 to `HOME_URL`                                         |
| `GET /<file>`                       | The built client: scripts, styles, fonts, manifest, icons |
| `GET /rooms/<board>/connect`        | The tldraw sync socket (`?sessionId=&pass=`)              |
| `POST /rooms/<board>/roll`          | Rolls `{"dice": [6, 6]}` for everyone                     |
| `GET /rooms/<board>/rolls`          | The latest 50 rolls                                       |
| `POST /rooms/<board>/delete`        | Deletes the board's data (deletion token)                 |
| `POST /rooms/<board>/files`         | Uploads an image (the bytes as the body); see "Images"    |
| `POST /rooms/<board>/files/access`  | Sets the cookie the board's `<img>`s read images with     |
| `GET /rooms/<board>/files/<sha256>` | An image of the board                                     |

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
(`default-src 'none'`; scripts, styles, fonts and images from itself; the
rooms socket; the host's origin) and the usual hardening headers.

## Images

A board's images live in one R2 bucket per deployment (`Files`; the Alchemy
helper makes it, `wrangler.json` binds a local one), under
`boards/<board>/<sha256>`. Both modes treat them the same way, behind the
same pass that opens the board.

- **Upload.** `POST /rooms/<board>/files` with `Authorization: Bearer
<pass>` and the bytes as the body. The Worker reads the type from the
  bytes, never from the name or the declared type: PNG (and APNG), JPEG,
  WebP, GIF, AVIF and SVG. It hashes the bytes itself, so the same image is
  stored once per board and sending it again answers the same address
  (`201` the first time, `200` after; `{"src", "hash", "type", "bytes"}`).
  The hash stays the image's name in the document, for anything that wants
  to key on the content later.
- **Refusals**, as `{"error"}`: `403` without a valid pass for this board
  or after a link reset, `400` empty, `413` over 10 MiB, `415` not one of
  those types, `429` a person's 61st upload in a minute, `507` the board's
  256 MiB of images is full (each distinct image counted once). The limits
  are in `src/limits.ts`. The board's Durable Object keeps the ledger
  (what it stores, and each person's recent uploads), so quota and rate
  hold however many Workers take uploads at once.
- **Reading.** An `<img>` cannot send an Authorization header, so the
  client trades its pass for a cookie: `POST /rooms/<board>/files/access`
  (Bearer pass) answers `Set-Cookie: tabletop-files=<the pass>;
Path=/rooms/<board>/files; Max-Age=<the pass's remaining life>; Secure;
HttpOnly; SameSite=Strict`. The client does this again whenever its pass
  is renewed, and tldraw asks the asset store before it shows an image, so
  a tab that slept past the pass's five minutes gets a fresh cookie before
  its next image loads. The cookie is read only on `GET`/`HEAD` of the
  board's own files path: an upload still needs the header, so a page
  elsewhere cannot spend it, and a cookie for one board says nothing on
  another's path. Guests have passes like anyone else; iOS Safari keeps a
  first-party, server-set cookie like this one. Each read still asks the
  board's Durable Object, so a reset link stops the old passes at once.
  A signed URL would have put the pass in every image's address, changing
  every four minutes, which defeats the browser's cache; the cookie keeps
  one stable address per image.
- **Serving.** The type the bytes were sniffed as, `X-Content-Type-Options:
nosniff`, `Cache-Control: private, max-age=31536000, immutable` (the
  address is the content), `ETag`, range requests (`206`), the board's
  hardening headers, and `Content-Security-Policy: default-src 'none';
style-src 'unsafe-inline'; sandbox` with `Cross-Origin-Resource-Policy:
same-origin`. An image opened on its own therefore runs nothing and loads
  nothing; an SVG is also sent with `Content-Disposition: attachment`, and
  tldraw sanitises SVGs before they are uploaded.
- **Deleting.** Deleting a board (the host's `delete` or a standalone
  owner's) removes every object under its prefix before the rest of its
  data. Deleting an image's shape on the canvas removes nothing: tldraw
  keeps the asset record, undo brings the shape back, and the same image
  may sit in several shapes or in a .tldr someone exported.
  TODO: a sweep that deletes an object once no asset record in the board's
  document has pointed at its hash for 30 days.
- **Logs.** One `board.file_upload` event per upload or refusal: board id,
  person kind (`member` or `guest`), bytes, sniffed type, outcome. No names.

The client (`client/src/assets.ts`, `images.ts`, `file-flows.ts`) takes
images from tldraw's picker (on a phone: the photo library or the camera),
drops, pastes, several at once. A still JPEG, PNG or WebP whose long side
is over 4096 px, or that weighs over 10 MiB, is redrawn to fit (JPEG at
quality 0.9, or WebP where transparency must stay; lower qualities and
then smaller sizes only if still too heavy), with the phone's orientation
applied. 4096 px keeps a page scanned at 300 dpi (A4 is 2480 × 3508)
untouched and a 12 MP photo at full size. Uploads show their progress,
retry a dropped connection three times (1, 3, 8 s) and a busy Worker five
times (15 s), and say why when refused. The page's policy allows images
from `'self'` (and `blob:`, for tldraw's preview while one uploads).

## .tldr files

The board's menu downloads the whole board as tldraw's own file: every
page in order, every shape with its styles, ids and `meta` (places too),
bindings, and every image embedded as a `data:` URL, so the file opens on
tldraw.com or any tldraw app without this server. It opens such a file
too, from the menu or dropped onto the board:

- A board holds at most 40 pages, tldraw's own cap, which its page menu
  keeps too. A file whose pages would pass it is refused whole, before any
  of its images is uploaded, with a message saying how many more fit.
- The file's pages are added after the board's own, never in its place.
  On a board nobody has drawn on (one empty page), the file's pages take
  the empty page's place, so the board reads exactly as the file.
- An id the board already uses gets a new one; parents, bindings and image
  references follow it, so opening the same file twice gives two whole
  copies.
- Embedded images are uploaded first, with their exact bytes, and the
  document only ever points at their R2 addresses. If one cannot be
  uploaded, nothing is added.
- A file from an older tldraw is migrated by tldraw's own migrations; one
  from a newer schema than this board's is refused with a message saying
  so. Files are capped at 400 MiB.
- The file's document record (its name and grid size) and its camera and
  selection are not taken: the board keeps its own.

The end-to-end tests open fixtures that `node e2e/fixtures/make-fixtures.ts`
writes with this repository's tldraw schema (no file exported from
tldraw.com is checked in), and compare what a second browser downloads with
them record for record, images by their SHA-256.

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
bundled by Alchemy), the `BoardRoom` Durable Object, the R2 bucket of the
boards' images (`<app>-<stage>-<id>Files`, returned as `files`; a bucket
with images in it is never destroyed with the stack) and the custom
domains.
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
host), and `wrangler dev` trusts the dev key from `.dev.vars`. For
standalone mode, build with `TABLETOP_MODE=standalone`, run
`node e2e/fake-workos.ts`, apply `wrangler d1 migrations apply DB --local`,
and start `wrangler dev --env-file e2e/standalone.env`; the e2e config does
exactly this on :8790.

## Dice

The server draws every value (`src/dice.ts`) and gives each roll an unsigned
32-bit `seed`. The seed shapes only the animation: every client simulates
the same throw from it and then turns each die's numbering so the server's
value is on top. Values never come from the physics.

The throw is the tabletop's own code: a small rigid-body simulation
(`client/src/dice-math.ts`, `dice-solids.ts`, `dice-physics.ts`,
`dice-throw.ts`) and a WebGL2 renderer (`dice-mesh.ts`, `dice-atlas.ts`,
`dice-renderer.ts`, `dice-scene.ts`). A physics engine in WebAssembly or a
worker would need a wider Content-Security-Policy, and general engines do
not promise the same floats in every browser; this one is under a tenth of
the size of the three.js dice it replaced and loads as one lazy chunk.

**The determinism rule.** From the seed to the last frame, the simulation
may use only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`,
`Math.floor` and `Math.imul`, with a fixed step (1/240 s), a fixed number of
solver iterations and a fixed body order. Those are exact in every
JavaScript engine; `Math.sin`, `cos`, `atan2`, `pow`, `exp`, `hypot` and
the rest are not, so shape constants are closed forms in square roots and
random rotations are normalised random quaternions. Three checks keep it:

- `test/dice-exact.test.ts` runs a throw with every other `Math` function
  stubbed to throw;
- `e2e/tests/dice-determinism.spec.ts` runs 200 seeded throws in Chromium,
  Firefox and WebKit and compares each frame hash with Node's;
- `test/dice-throw.test.ts` pins the hashes of two throws. That tripwire
  changes only when the simulation is changed on purpose: run the
  cross-engine spec first, then paste the hashes the failing test prints.
  Clients on the old and the new build would see different throws until
  they reload.

The renderer is free of the rule: nothing it computes feeds back into the
frames.

**The tray.** Dice are thrown in a virtual tray of 10 by 14 units. The
renderer fits that rectangle, aspect kept, into the area between the result
strip and the bottom bar and centres it (`trayRect` in `dice-renderer.ts`),
so a die lands on the same spot of the tray on every screen, whatever its
size.

A device that asks for reduced motion never loads the 3D code and gets the
result strip at once; so does one without WebGL2, or after any error in the
dice, which is logged once. Software rendering or a weak device gets a
cheaper drawing of the same throw; `localStorage["tabletop.dice-tier"]` set
to `low` or `full` forces one. The dice take `--brand-primary`; `LOOK` in
`dice-scene.ts` switches to ivory with dark ink.

## Standalone mode

The tabletop is its own host. Owners sign in and keep a list of their
boards; anyone with a board's link joins as a guest with a display name,
exactly as in hosted mode, and never touches the sign-in provider. A
signed-in person who opens someone else's board joins under their account
name, and the board appears in their list as joined.

The Worker answers the host contract itself: the client asks
`POST /api/b/<share code>/bootstrap` on its own origin, gets the same
answers as from a host, and the Worker signs the pass with its own key
(`iss` `tabletop`, `aud` `tabletop-standalone`), which the rooms verify
through the same code path. A hosted configuration may not use those names
and a standalone one may not set a host's key, so a pass from one mode never
opens a board in the other, even when both trust the same key.

### Configuration

| Variable                      | Helper prop          | Meaning                                                               |
| ----------------------------- | -------------------- | --------------------------------------------------------------------- |
| `TABLETOP_MODE`               | `mode`               | `standalone`                                                          |
| `SIGNING_KEY`                 | `signingKey`         | Secret. RSA private key, PKCS#8 PEM. The committed dev key is refused |
| `WORKOS_CLIENT_ID`            | `workOs.clientId`    | The WorkOS application's client id                                    |
| `WORKOS_API_KEY`              | `workOs.apiKey`      | Secret. The WorkOS API key (`sk_...`)                                 |
| `WORKOS_API_BASE`             |                      | The WorkOS API's origin; only tests set it, to a fake                 |
| `DISPLAY_NAME`                | `displayName`        | Where a guest is sent back to ("Back to Tabletop")                    |
| `PRIMARY_HOST`, `ALIAS_HOSTS` | `domain`             | As in hosted mode                                                     |
| `DB`                          | (made by the helper) | D1 database, schema in `migrations/`                                  |
| `Files`                       | (made by the helper) | R2 bucket of the boards' images; in hosted mode too                   |
| `Limiter`                     | (made by the helper) | Durable Object counting requests per client address                   |

`alchemy.run.ts` deploys this repository's copy: stages `prod` (on
`TABLETOP_DOMAIN`) and `staging` (on `staging.<TABLETOP_DOMAIN>`), any other
stage a workers.dev preview. It reads `TABLETOP_DOMAIN`,
`TABLETOP_SIGNING_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` and
`TLDRAW_LICENSE_KEY` from the environment; none is committed.

### Data

Live board state (the tldraw document, the roll log, the link version)
stays in the board's Durable Object. D1 keeps what has to be listed or
looked up across boards:

| Table      | Holds                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| `accounts` | id (the provider's user id), name and avatar from the last sign-in                  |
| `sessions` | SHA-256 of the cookie token, account, the provider's session id, CSRF token, expiry |
| `boards`   | id, owner, title, share code (unique), link version                                 |
| `visits`   | account, board, the share code they came by, when                                   |

A Durable Object per account could hold a list of boards, but a link names
a board by its share code, and finding a board from a code then needs an
index across all accounts anyway; D1 gives both with two indexes.

### Sessions and CSRF

- Sign-in is a redirect: `GET /auth/sign-in?return=/path` sets a short-lived
  sealed cookie with a `state` and a PKCE verifier and sends the browser to
  the provider; `GET /auth/callback` checks the state, trades the code
  (with the verifier) for the person, and opens a session. A `return` that
  is not a path on this origin becomes `/`.
- The session cookie is `__Host-tabletop-session`: Secure, HttpOnly,
  SameSite=Lax, Path=/, 30 days. Only a SHA-256 of its random token is
  stored.
- Every state-changing route needs `Origin` equal to the tabletop's own and
  a JSON body (which no other origin sends without a preflight). Owner
  actions and sign-out also need `X-CSRF-Token` equal to the session's
  token, which `GET /api/me` gives to the page.
- A guest's id and name live in `__Host-tabletop-guest`, signed by the
  Worker's key under its own audience.
- Board actions name the account in their queries, so a board that is not
  the account's answers 404 and nothing changes.

### Routes

| Route                                     | Does                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /`                                   | The front page: sign in, then the account's boards                                                  |
| `GET /auth/sign-in`, `GET /auth/callback` | The redirect sign-in                                                                                |
| `POST /auth/sign-out`                     | Ends the session; answers `{"redirect"}`, the provider's sign-out                                   |
| `GET /api/me`                             | `{"account": {"id", "name"}, "csrf"}`; both null when signed out                                    |
| `GET /api/boards`                         | `{"owned": [...], "visited": [...]}`; a visited board's `shareCode` is null once its link was reset |
| `POST /api/boards`                        | `{"title"}`: makes a board (201). 100 per account, 20 an hour                                       |
| `POST /api/boards/<id>/rename`            | `{"title"}`, owner only                                                                             |
| `POST /api/boards/<id>/reset`             | New share code and link version; puts out everyone on the old link. Owner only                      |
| `POST /api/boards/<id>/delete`            | Forgets the board and wipes its room (204). Owner only                                              |
| `POST /api/b/<share code>/bootstrap`      | The pass request of the host contract. 30 a minute per address                                      |

The client IP for the limits comes from `CF-Connecting-IP` only; the
limiter stores a hash of it.

### The sign-in provider

`src/standalone/provider.ts` is the one seam: a provider builds the
authorization URL (with `state` and a PKCE challenge), trades a code for
`{subject, name, avatarUrl, providerSession}`, and optionally builds a
sign-out URL. `src/standalone/workos.ts` implements it for WorkOS AuthKit's
hosted page with plain `fetch` (no SDK): `GET /user_management/authorize`
with `provider=authkit`, `POST /user_management/authenticate` with the code,
the API key and the PKCE verifier, and `/user_management/sessions/logout`
with the `sid` from the access token. The Worker keeps no WorkOS tokens:
the access and refresh tokens are dropped after sign-in, and the
tabletop's own session decides who is signed in.

Tests never call WorkOS: `e2e/fake-workos.ts` answers those three endpoints
(checking the client id, secret, single-use codes and PKCE), as the
Worker's outbound fetch in Vitest and as a server in Playwright.

## Deploying from GitHub

`.github/workflows/deploy.yml` deploys this repository's standalone copy
(`alchemy.run.ts`) with `alchemy deploy --stage <stage> --yes`, after the
CI checks (`ci.yml`, called as a reusable workflow) pass:

- every push to `main` deploys stage `staging`;
- "Run workflow" on the Deploy workflow deploys the stage it is given:
  `staging`, `prod` (only from `main`), or a preview name (lowercase
  letters, digits and hyphens), which gets a Worker, a D1 database and an
  R2 bucket of its own on workers.dev.

Each stage is what `Tabletop(...)` (`alchemy/index.js`) declares for
standalone mode: the Worker with the built client as its static assets,
the `BoardRoom` and `Limiter` Durable Objects, the D1 database with
`migrations/` applied, the R2 bucket of the boards' images
(`<app>-<stage>-TabletopFiles`), and the custom domain when there is one.
A bucket with images in it is never destroyed with its stage, so a preview
stage that someone uploaded to leaves its bucket behind until it is
emptied by hand.

One deploy per stage runs at a time; a later one waits. The job summary
and the Environment's deployment show the URL. Until an Environment has
every required input, its deploys end green with a notice listing what is
missing, and nothing is deployed; once they are there, a failed deploy fails
the run.

### What to create

**A Cloudflare API token** (My Profile, API Tokens, Create Custom Token),
for the account the tabletop deploys to:

| Scope                           | Permission               | For                                                                                       |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| Account                         | Workers Scripts: Edit    | The Worker, its assets, `BoardRoom` and `Limiter`, workers.dev, the state store's Worker  |
| Account                         | D1: Edit                 | The database, and its migrations, which Alchemy applies on each deploy                    |
| Account                         | Workers R2 Storage: Edit | The bucket of the boards' images, made on the first deploy and bound to the Worker        |
| Account                         | Secrets Store: Edit      | The state store's token and encryption key (read alone is not enough: Alchemy binds them) |
| Zone: the `TABLETOP_DOMAIN` one | Zone: Read               | Finding the zone of a custom domain                                                       |
| Zone: the `TABLETOP_DOMAIN` one | Workers Routes: Edit     | Attaching the custom domain                                                               |
| Zone: the `TABLETOP_DOMAIN` one | DNS: Edit                | The DNS record the custom domain gets                                                     |

The zone rows matter only once `TABLETOP_DOMAIN` is set, and that zone must
be in the same account. Alchemy keeps its deploy state in the account's
state store, a Worker named `alchemy-state-store` with a Durable Object; the
first deploy creates it (and the account's Secrets Store, if there is none),
so the state store needs no secret of its own here. An account whose store
already exists, from another project, reuses it.

**Two GitHub Environments** (Settings, Environments): `staging`, used by
`staging` and every preview stage, and `production`, used by `prod`. Give
`production` a deployment branch rule for `main` and, if you like, required
reviewers.

| Kind     | Name                    | Value                                                                                           |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| secret   | `CLOUDFLARE_API_TOKEN`  | The token above                                                                                 |
| variable | `CLOUDFLARE_ACCOUNT_ID` | The account's id (the dashboard's URL, or Workers & Pages, Account details)                     |
| secret   | `WORKOS_API_KEY`        | The WorkOS environment's API key (`sk_...`)                                                     |
| variable | `WORKOS_CLIENT_ID`      | That environment's client id                                                                    |
| secret   | `TABLETOP_SIGNING_KEY`  | A key of this Environment's own: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` |
| variable | `TABLETOP_DOMAIN`       | Optional. The apex the tabletop serves: `prod` on it, `staging` on `staging.<it>`               |
| variable | `TLDRAW_LICENSE_KEY`    | Optional to deploy, but see below. Public by design                                             |

All but the two optional ones are required. Use WorkOS's staging environment
for `staging` and its production one for `production`.

### The first deploy, on workers.dev

The custom domain can come later. Without `TABLETOP_DOMAIN`, `staging`
serves `https://tabletop-staging.<account subdomain>.workers.dev` and `prod`
`https://tabletop.<account subdomain>.workers.dev`. WorkOS needs that
address, which you only learn from the first deploy:

1. Set the Environment's inputs and deploy (push to `main`, or run the
   workflow).
2. Read the URL from the run's summary.
3. In WorkOS, add `https://<that host>/auth/callback` as a redirect URI and
   `https://<that host>/` as a sign-out redirect. Sign-in works from then
   on; nothing needs redeploying.

Setting `TABLETOP_DOMAIN` later moves `prod` and `staging` to their custom
domains on the next deploy; register those hosts the same way. A preview
stage has its own workers.dev host, which needs registering too before
anyone signs in there.

tldraw's SDK runs without a licence key only on local addresses
(`localhost`), so a deploy without `TLDRAW_LICENSE_KEY` succeeds, with a
warning, but its boards do not work. tldraw ties a key to its domains: get
one that covers every host the Environment deploys to.
