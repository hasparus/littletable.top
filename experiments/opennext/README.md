# Little Table on OpenNext

This draft puts two documents on the Next.js App Router and runs the built app with the Cloudflare OpenNext adapter. Request `/?renderer=opennext` or `/boards?renderer=opennext` to select the experiment. The same paths without the parameter are the existing Vite and Worker control.

- The OpenNext landing page renders the existing intro copy in the initial document and starts the same Vite editor after hydration. Both use the same loader hints and call the same public board bootstrap.
- The OpenNext boards page renders the shared `BoardsApp` with the signed-in list from the existing Worker’s `/api/boards`. It reuses the baseline UI, account identity, cookies, and D1 fixtures.
- A local service binding routes API, auth, editor, assets, and WebSocket requests to the unchanged Worker. Both variants run under the same origin and local `workerd` process. OpenNext’s extra service call for boards is part of the measured migration.

The experiment uses the existing fake WorkOS and a local database. Its config declares no public hostname or production resources. It does not replace the production build or migrate storage, auth, editor, or file handling. Use the normal Wrangler service-binding setup if evaluating a future separate staging deployment. Do not use the fixture server with customer data.

## Run

With the repository’s Node and Bun versions and Chromium for Playwright installed, install the two locked dependency trees.

```sh
bun install --frozen-lockfile
(cd experiments/opennext && bun install --frozen-lockfile)
bash experiments/opennext/scripts/serve.sh
```

From another shell, run:

```sh
node experiments/opennext/scripts/bench.mjs
```

Set `CHROMIUM_PATH` for system Chromium. To override the local server port, set `OPENNEXT_PORT` in the server shell and pass the corresponding origin to the benchmark. Set `OPENNEXT_WORKOS_PORT` to change the fake provider port. `BENCH_SAMPLES` changes the default ten measured pairs per route. Stop the local server with Ctrl-C.

## Read the results

The benchmark seeds one private board via the normal local sign-in and board APIs. Before any timed samples, it verifies both board titles are rendered without JavaScript, verifies the OpenNext intro is rendered without JavaScript, and checks that a signed-out request cannot see the seeded title. It uses fresh Chromium contexts, alternates the renderers, and drops one warm-up pair for each route. The output includes medians and raw samples.

- On landing, compare TTFB, first contentful paint, the first frame with the intro visible, and the first frame with the active canvas visible.
- On boards, compare TTFB, first contentful paint, and the first frame with the private board title visible.
- Decoded document size includes Next’s serialized hydration payload. The experiment measures local render and browser work. Edge network latency, cold isolates, deployment cache behavior, and billing require separate measurements.

## First local run

Ten measured Chromium pairs per route on the same loopback Worker. Times are medians in milliseconds.

| Route and renderer            | TTFB | First contentful paint | Intro or title visible | Active canvas visible | Decoded HTML |
| ----------------------------- | ---: | ---------------------: | ---------------------: | --------------------: | -----------: |
| Landing, Vite Worker          |   10 |                    212 |                    188 |                   652 |      2,899 B |
| Landing, OpenNext             |   24 |                    132 |                    114 |                   693 |     12,155 B |
| Signed-in boards, Vite Worker |   16 |                    118 |                     98 |                       |      9,636 B |
| Signed-in boards, OpenNext    |   33 |                    148 |                    133 |                       |     13,714 B |

OpenNext exposed the intro 74 ms earlier and the active canvas 41 ms later in this run. The boards title appeared 35 ms later. Landing intentionally compares the existing client-introduced markup with a server-rendered version, so the intro timing includes the rendering change. To isolate the runtime effect on landing, run a follow-up with the same intro prerendered by Vite. The boards result includes OpenNext reaching D1 through the existing service API.

References: [OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare/get-started), [custom Worker entry](https://opennext.js.org/cloudflare/howtos/custom-worker), and [Wrangler multi-Worker development](https://developers.cloudflare.com/workers/local-development/multi-workers/).
