# Internals

Facts the code does not say quickly: formats, invariants, and the reasons
behind the security choices. Limits live in `src/limits.ts`.

## Images

A board's images live in one R2 bucket per deployment (`Files`) as
`boards/<board>/<sha256>`, behind the same pass that opens the board.

- The Worker reads the type from the bytes, never the name or declared
  type: PNG (and APNG), JPEG, WebP, GIF, AVIF and SVG. It hashes the bytes
  itself, so an image is stored once per board. The board's Durable Object
  keeps the ledger, so quota and rate hold across Workers.
- An `<img>` cannot send an Authorization header, so
  `POST /rooms/<board>/files/access` trades the pass for a cookie:
  `tabletop-files=<the pass>; Path=/rooms/<board>/files; Secure; HttpOnly;
SameSite=Strict`, living as long as the pass. It is read only on
  `GET`/`HEAD` of that path, so uploads still need the header and a page
  elsewhere cannot spend it. A signed URL would change every four minutes
  and defeat the browser's cache; the cookie keeps one address per image.
- Files are served with the sniffed type, `nosniff`,
  `private, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy:
same-origin` and `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox`. An SVG also gets `Content-Disposition:
attachment`; tldraw sanitises SVGs before upload.
- Deleting a board removes every object under its prefix. Deleting a shape
  removes nothing: undo brings it back, and the image may sit in other
  shapes or an exported .tldr.
  TODO: a sweep that deletes an object once no asset record has pointed at
  its hash for 30 days.
- The client redraws a still JPEG, PNG or WebP over 4096 px or 10 MiB to
  fit. 4096 px keeps an A4 page at 300 dpi and a 12 MP photo untouched.

## Avatars

Pictures are never hot-linked. The Worker copies each into the bucket as
`avatars/<sha256>` and serves it itself, so images stay `'self'` and no
player's browser contacts the identity provider or the host.

- The copy (`src/avatars.ts`): `https` only, no address literals or local
  names, every redirect hop checked again. PNG, JPEG, GIF, WebP or AVIF; an
  SVG is refused. Any failure leaves an initial and never fails the request.
- Hosted: the board's Durable Object copies the pass's `avatar` claim, only
  from `HOST_ORIGIN`, again only when the claim changes.
- `GET /rooms/<board>/files/avatars/<sha256>` answers only for someone who
  has been on that board; any other hash is a 404.
- The room overwrites the user id, name and `meta.avatar` of every presence
  push with what the pass says (`src/presence.ts`), so a client cannot
  appear as someone else.
- Avatars are shared across boards and accounts, so deleting a board leaves
  them.
  TODO: deleting an account (not built yet) must delete its picture once no
  account and no board's `people` row names its hash.

## Search

Search runs in the person's own browser (`client/src/search-*.ts`, on
MiniSearch). Neither the query nor the result's flash is synced or sent.

## Text in images

Text in a board's images is read in people's browsers and joins the search.
Nothing is read on a server or by an outside service, and the text is only
ever shown as text.

- The uploader's browser reads an image right away. Others fill in unread
  images by claiming one from the board's Durable Object under a 30 s
  lease, so two browsers never read the same image. After three failures
  of an image with one engine version the board stops handing it out.
- Two engines run in a worker of this origin: Tesseract (tesseract.js,
  `tessdata_fast` `pol+eng`) and PP-OCRv6 tiny on onnxruntime-web
  (`client/src/ppocr.ts`). A device without WebAssembly SIMD, with under
  4 GB of memory or saving data runs Tesseract alone. A failed WebAssembly
  start can hang, so each engine has a time limit.
- `client/src/text-filter.ts` drops what engines read off a map's
  mountains and trees. On the 14 evaluation fixtures it keeps 93% of the
  names people search for and cuts junk words from 379 to 81.

### The stored result

One JSON object per image and engine version, in R2 as
`boards/<board>/<sha256>.ocr.<engine>-<version>.json`, format `ocr/1`:

```json
{
  "format": "ocr/1",
  "image": { "sha256": "…", "width": 2048, "height": 1536 },
  "engine": { "name": "ppocr", "version": "v6tiny.1", "model": "…", "params": { "detMaxSide": 960 } },
  "source": "uploader",
  "createdAt": "2026-11-23T10:00:00.000Z",
  "lines": [{ "box": [x0, y0, x1, y1], "quad": [8 numbers], "words": [{ "t": "Zatoka", "c": 0.92, "b": [x0, y0, x1, y1], "q": [8 numbers] }] }]
}
```

Pixels are the image's as the board shows it (EXIF orientation applied),
lines in reading order, `q` a word's corners clockwise from its top left
(PP-OCR only); `source` is `uploader` or `peer`. The engine keys are in
`src/text-result.ts`; a new model or new parameters get a new key, read
beside the old.

| Route                                          | Does                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `GET /rooms/<board>/files/text`                | `{"stored", "reading", "failed"}`: `{hash, engine}` pairs            |
| `POST /rooms/<board>/files/text/claim`         | `{"candidates", "engines", "prefer"}` → a lease on one image, or 204 |
| `POST /rooms/<board>/files/text/renew`         | `{"lease"}` → 204, or 409 once it ran out                            |
| `POST /rooms/<board>/files/text/release`       | `{"lease", "failed"}` → 204                                          |
| `PUT /rooms/<board>/files/<sha256>/text/<key>` | Stores a reading: 201, or 200 with the one already stored            |
| `GET /rooms/<board>/files/<sha256>/text/<key>` | A stored reading, cached for good as an image is                     |

The Worker treats a reading as untrusted. The image must be one of the
board's and not an SVG; the stated size must match the stored image's
header (`src/image-size.ts`; a JPEG's EXIF orientation applied, other
formats accepted either way up); boxes lie inside it; confidences are in
[0, 1]; words are NFC-normalised with control, format and space characters
removed; at most one word per 64 pixels of image. It stores its own rebuilt
copy with its own timestamp. The first valid reading per image and engine
wins. Readings count against the board's 256 MiB and go with the board.

### Self-hosted files

Under `/assets/ocr/`, each with its content's hash in its name (Tesseract's
language data in a hashed folder, as it fixes the names), fetched only when
a browser reads an image. The page's policy adds only `'wasm-unsafe-eval'`
and `worker-src 'self'`: tesseract.js starts its worker from its file here,
never a blob: URL, and runs single-threaded without cross-origin isolation.
The first reading downloads about 15 MB.

| File                                       | From                                                        | Licence    |
| ------------------------------------------ | ----------------------------------------------------------- | ---------- |
| tesseract.js 6.0.1 worker                  | npm `tesseract.js`                                          | Apache-2.0 |
| Tesseract core, SIMD and plain (LSTM only) | npm `tesseract.js-core` 6.1.2                               | Apache-2.0 |
| `pol`, `eng` traineddata (`client/ocr/`)   | tesseract-ocr/tessdata_fast 4.1.0, gzipped                  | Apache-2.0 |
| onnxruntime-web 1.31.1 WebAssembly         | npm `onnxruntime-web`                                       | MIT        |
| PP-OCRv6 tiny detector and recogniser      | PaddleOCR's `PP-OCRv6_tiny_{det,rec}` ONNX inference models | Apache-2.0 |
| The recogniser's dictionary                | that model's `inference.yml`, as JSON                       | Apache-2.0 |

SHA-256 of the vendored files:

| File                     | SHA-256 (traineddata before gzip)                                  |
| ------------------------ | ------------------------------------------------------------------ |
| `pol.traineddata`        | `c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2` |
| `eng.traineddata`        | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |
| `ppocr-v6-tiny-det.onnx` | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` |
| `ppocr-v6-tiny-rec.onnx` | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` |

## .tldr files

The board's menu downloads the whole board as a tldraw file, images
embedded as `data:` URLs, so it opens in any tldraw app. Opening one:

- A board holds at most 40 pages. A file that would pass that is refused
  whole, before any image is uploaded.
- The file's pages are added after the board's own; on an untouched board
  (one empty page) they replace it.
- An id the board already uses gets a new one, with parents, bindings and
  image references following, so opening a file twice gives two copies.
- Embedded images are uploaded first, with their exact bytes. If one fails,
  nothing is added.
- An older schema is migrated; a newer one is refused. The file's document
  record, camera and selection are not taken.

## Dice

The server draws every value (`src/dice.ts`) and gives each roll a 32-bit
`seed`. The seed shapes only the animation: every client simulates the same
throw and then turns each die so the server's value is on top.

**The determinism rule.** From the seed to the last frame the simulation
uses only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`,
`Math.floor` and `Math.imul`, with a fixed step (1/240 s), solver iteration
count and body order. Those are exact in every JavaScript engine; `sin`,
`cos`, `atan2`, `pow` and the rest are not. A physics engine in
WebAssembly would also need a wider Content-Security-Policy.

- `test/dice-exact.test.ts` runs a throw with every other `Math` function
  stubbed to throw.
- `e2e/tests/dice-determinism.spec.ts` compares 200 seeded throws in
  Chromium, Firefox and WebKit with Node's, frame by frame.
- `test/dice-throw.test.ts` pins the hashes of two throws. After a
  deliberate change, run the cross-engine spec first, then paste the hashes
  the failing test prints. Clients on old and new builds see different
  throws until they reload.

The renderer is free of the rule: nothing it computes feeds the frames.
Numerals are centred by their ink, from `client/src/dice-numeral-centres.ts`;
after changing the font, `node e2e/numeral-centres.ts` rewrites it.

## Standalone mode

The Worker answers the host contract itself: `POST /api/b/<share
code>/bootstrap` on its own origin, with passes signed by its own key
(`iss` `tabletop`, `aud` `tabletop-standalone`).

### Data

Live board state stays in the board's Durable Object. D1 (`migrations/`)
keeps what is listed or looked up across boards: `accounts`, `sessions`,
`boards` and `visits`. A link names a board by its share code, and finding
a board from a code needs an index across all accounts, which D1 gives.
The public board uses a fixed room ID outside the account board ID space.
It has no owner or D1 row.

### Sessions and CSRF

- Sign-in is a redirect with `state` and a PKCE verifier in a short-lived
  sealed cookie. A `return` that is not a path on this origin becomes `/`.
- The session cookie is `__Host-tabletop-session`: Secure, HttpOnly,
  SameSite=Lax, 30 days. Only a SHA-256 of its token is stored.
- Every state-changing route needs `Origin` equal to the tabletop's own and
  a JSON body, which no other origin sends without a preflight. Owner
  actions and sign-out also need `X-CSRF-Token`, from `GET /api/me`.
- A guest's id and name live in `__Host-tabletop-guest`, signed under its
  own audience. The public board assigns guests a name immediately and keeps
  it in `__Host-tabletop-public-guest`. Share links still ask new guests for
  their names.
- Board actions name the account in their queries, so someone else's board
  answers 404 and nothing changes.
- The limits' client IP comes from `CF-Connecting-IP` only; the limiter
  stores a hash of it.

### Routes

| Route                                     | Does                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /`                                   | Opens the shared public whiteboard                                             |
| `GET /boards`                             | Sign-in and the account's boards                                               |
| `GET /auth/sign-in`, `GET /auth/callback` | The redirect sign-in                                                           |
| `POST /auth/sign-out`                     | Ends the session; answers `{"redirect"}`, the provider's sign-out              |
| `GET /api/me`                             | `{"account": {"id", "name", "avatar"}, "csrf"}`; both null when signed out     |
| `GET /api/avatars/<sha256>`               | The signed-in account's own picture; 404 for anyone else's                     |
| `GET /api/boards`                         | `{"owned", "visited"}`; a visited board's `shareCode` is null after a reset    |
| `POST /api/boards`                        | `{"title"}`: makes a board (201)                                               |
| `POST /api/boards/<id>/rename`            | `{"title"}`, owner only                                                        |
| `POST /api/boards/<id>/reset`             | New share code and link version; puts out everyone on the old link. Owner only |
| `POST /api/boards/<id>/delete`            | Forgets the board and wipes its room (204). Owner only                         |
| `POST /api/b/<share code>/bootstrap`      | The pass request of the host contract                                          |
| `POST /api/public-board/bootstrap`        | Issues a member or guest pass for the public board                             |

### The sign-in provider

`src/standalone/provider.ts` is the one seam; `src/standalone/workos.ts`
implements it for WorkOS AuthKit with plain `fetch`. The Worker drops
WorkOS's access and refresh tokens after sign-in; its own session decides
who is signed in. Tests never call WorkOS: `e2e/fake-workos.ts` answers
instead.
