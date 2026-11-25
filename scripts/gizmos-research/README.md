# A programmable encounter clock

Run from the repository root with Node 24.

```sh
node scripts/gizmos-research/clock-wasm.mjs
```

The host starts a fresh worker for each attempt. A rule receives the current segment count as an integer and proposes the next count. It receives no board records, session credentials, storage bindings, or imported functions. Only an integer in the inclusive range 0–6 can become the result. All fixtures are valid WebAssembly modules, including the ones the host declines to run.

| Rule attempt               | Observed result                            |
| -------------------------- | ------------------------------------------ |
| Add one to 3               | Proposed 4                                 |
| Add one to 6               | Rejected 7                                 |
| Request a host function    | Rejected the import                        |
| Declare an internal memory | Rejected the memory section                |
| Loop indefinitely          | Host terminated the worker at its deadline |

The worker accepts modules of up to 512 bytes with one function export named `step`. It permits only the type, function, export and code sections, each with a single-byte length. These constraints keep the experiment inspectable. Many ordinary compiler outputs include additional sections and would need a different policy.

The parent gives each run a 1.5-second wall-clock budget, including worker startup and compilation, and awaits termination. Node schedules the timer on the host event loop, so the deadline is approximate. Rejecting linear memory limits the module format. Compiling and running a module still uses native memory, and worker threads share the Node process. This experiment establishes neither a per-tenant memory ceiling nor a security boundary for running arbitrary uploads. The command runs only the fixtures in this directory.

In a deployed table, a room handler would still have to authorize the player, check the owner-installed rule version, compare the current clock revision, and commit the proposed change once. This experiment performs no network request or shared state write.

## Spotlight graphics

The notebook draws its six pressure markers from TypeGPU Kit circle geometry. The ordinary DOM meter remains usable during initialization and on devices without WebGPU. To rebuild the static shader, run `bun install --frozen-lockfile` and `bun run generate` in `scripts/gizmos-research/spotlight-renderer`. This isolated fixture keeps the compiler off the live board. In Chromium with a software GPU, offscreen readback confirmed the six marker centers at 0, 3 and 6 pressure. The machine’s compositor lost the onscreen WebGPU surface. The tracker kept responding through its DOM meter.
