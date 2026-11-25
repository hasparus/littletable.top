# Hosting the tabletop

In hosted mode a host application owns accounts and boards and signs
passes; the tabletop trusts one issuer. `e2e/fake-host.ts` is a reference
host. `alchemy/index.d.ts` documents every helper prop.

## The host contract

### Worker configuration

The Alchemy helper sets these from its props; `wrangler.json` and
`.dev.vars` set them for `wrangler dev`.

| Variable              | Helper prop         | Meaning                                                                       |
| --------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `TABLETOP_MODE`       | `mode`              | `hosted`                                                                      |
| `ISSUER_PUBLIC_KEY`   | `issuerPublicKey`   | The host's RSA public key, SPKI PEM (`\n` escapes allowed). Passes are RS256  |
| `ISSUER`              | `issuer`            | The `iss` of the host's tokens. May not be `tabletop`                         |
| `PASS_AUDIENCE`       | `passAudience`      | The `aud` of passes. Default `board`. May not be `tabletop-standalone`        |
| `DELETION_AUDIENCE`   | `deletionAudience`  | The `aud` of deletion tokens. Default `board-deletion`; must differ           |
| `LINK_RESET_AUDIENCE` | `linkResetAudience` | The `aud` of link reset tokens. Default `board-link-reset`                    |
| `HOST_ORIGIN`         | `hostOrigin`        | The host's origin. The page's Content-Security-Policy allows it               |
| `HOME_URL`            | `homeUrl`           | Where `GET /` redirects (302). Default `HOST_ORIGIN/`                         |
| `PRIMARY_HOST`        | `domain.primary`    | The tabletop's own host. Empty: answer on any host                            |
| `ALIAS_HOSTS`         | `domain.aliases`    | Comma-separated hosts answered with a 308 to the same path on the primary one |

`tabletop` and `tabletop-standalone` are standalone mode's own issuer and
audience, so a pass from one mode never opens a board in the other. Hosted
passes, deletion tokens and link reset tokens each use a distinct audience. A
configuration that misses what its mode needs, or sets the other mode's
variables, answers 500 "This tabletop is not configured" to every request
and logs `tabletop.misconfigured`.

The client is built per deployment from the helper's `hostOrigin`,
`bootstrapPath`, `exitUrl`, `displayName`, `shortName`, `description`,
`language`, `brand`, `iconsDir` and `licenseKey`.

### The pass request

The tabletop serves `GET /b/<share code>` (1-64 ASCII letters and digits).
The client asks the host for a pass:

```http
POST <HOST_ORIGIN>/b/<share code>/bootstrap/
Origin: <the tabletop's origin>
Content-Type: application/json
Cookie: <the host's session cookie; credentials: "include">

{}                      (or {"name": "Bea"} once a guest has typed a name)
```

The host answers only the tabletop's origin, with
`Access-Control-Allow-Origin: <tabletop origin>`,
`Access-Control-Allow-Credentials: true` and `Vary: Origin`, and answers the
preflight with `Access-Control-Allow-Methods: POST` and
`Access-Control-Allow-Headers: Content-Type`. The JSON content type forces
a preflight, which takes the place of a CSRF token. The cookie reaches the
host only when the two hosts are the same site (`board.example.org` and
`example.org`) and its `SameSite` allows it.

| Status | Body                                                                                                  | The client                                 |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 200    | `{"pass", "board", "person": {"id", "name", "owner"}, "title", "home": {"name", "url"}, "boardsUrl"}` | opens the board                            |
| 422    | `{"error": "name-required"}`                                                                          | asks for a display name and sends it       |
| 422    | `{"error": "name-invalid"}`                                                                           | asks again, saying the name cannot be used |
| 403    | `{"error": "link-reset"}`                                                                             | says the link was reset                    |
| 404    | anything                                                                                              | says the board no longer exists            |
| 429    | anything                                                                                              | says to wait a minute                      |
| other  | anything                                                                                              | says it could not open the board; retry    |

`board` is the board's id (its room is `/rooms/<board>`), `person.id` is
the pass's `sub`, `boardsUrl` is a member's board list (`null` for a
guest), and `home` is where a guest leaves to. The client asks again before
its pass is four minutes old and whenever its socket reconnects; a 404 then
ends the board, and `name-required` ends it as a reset link.

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
| `avatar`     | Optional. The person's picture: a URL on `HOST_ORIGIN`         |
| `iat`, `exp` | Required. The reference host gives five minutes                |

The picture is a pass claim, not a bootstrap field, because the answer
reaches the Worker through the browser and only the pass is trusted. A URL
off `HOST_ORIGIN`, or one over 2048 characters, is ignored.

The pass travels as `?pass=` on the socket and `Authorization: Bearer`
elsewhere; images read it from a cookie (see
[internals](internals.md#images)). A pass with a higher `link` than the
board has seen moves the board on and closes every connection with a lower
one; a lower `link` is refused.

### Resetting a link

Give the board a new share code, increment its link version, and use that
version in later passes. To disconnect users of the old link immediately,
send `POST /rooms/<board>/link` server to server with
`Authorization: Bearer <token>`. The token is an RS256 JWT signed with the
same key and issuer as a pass, with `aud` set to `LINK_RESET_AUDIENCE` and
claims `board`, `link` (the new positive integer version), and `exp`.
A 204 means the room is at that version or newer. If the response is lost,
the host can retry the same version. Versions at or below the room's
current version have no effect.

### Deleting a board

A deletion token is a JWT with `aud` = `DELETION_AUDIENCE`, the same key
and issuer, and the claims `board` and `exp`. The host sends it server to
server: `POST /rooms/<board>/delete` with `Authorization: Bearer <token>`,
answered 204, repeatable. It removes the document, roll log, link version
and images; the same id starts again from link version 0. A pass cannot
delete, and a deletion token cannot open a socket or roll.

### Routes

| Route                                       | Does                                                  |
| ------------------------------------------- | ----------------------------------------------------- |
| `GET /b/<share code>`                       | The client's shell                                    |
| `GET /`                                     | 302 to `HOME_URL`                                     |
| `GET /rooms/<board>/connect`                | The tldraw sync socket (`?sessionId=&pass=`)          |
| `POST /rooms/<board>/roll`                  | Rolls a pool or dice expression for everyone          |
| `GET /rooms/<board>/rolls`                  | The latest 50 rolls                                   |
| `POST /rooms/<board>/link`                  | Advances the link version (link reset token)          |
| `POST /rooms/<board>/delete`                | Deletes the board's data (deletion token)             |
| `POST /rooms/<board>/files`                 | Uploads an image (the bytes as the body)              |
| `POST /rooms/<board>/files/access`          | Sets the cookie the board's `<img>`s read images with |
| `GET /rooms/<board>/files/<sha256>`         | An image of the board                                 |
| `GET /rooms/<board>/files/avatars/<sha256>` | The picture of someone who has been on the board      |

The rooms API is same-origin with the client and sends no CORS headers.
The room draws every die (d4, d6, d8, d10, d12, d20, d100; up to 20 at
once, one roll per person per 500 ms). It sends each roll to every
connection as a sync custom message, so no client can edit one.
Post `{"dice": [6, 6]}` for a plain pool or `{"expression": "3d6kh2 + 3"}`
for [dice notation](internals.md#dice). The roll includes the expression
when provided, in addition to the raw die values and throw seed.

A socket with a valid pass that must still be refused is accepted, then
closed at once with code 4099, which tldraw treats as final:

| Why                                   | Close reason |
| ------------------------------------- | ------------ |
| The link was reset (older version)    | `FORBIDDEN`  |
| The board is full (30 people)         | `ROOM_FULL`  |
| The board was deleted while connected | `NOT_FOUND`  |

A missing, invalid or wrong-board pass is a plain 403. `roll` and `rolls`
answer 403 for a reset link and 429 for a roll that comes too fast.
