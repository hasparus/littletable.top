# Seeded board link lifecycle experiment

A hosted board can learn about a new link version from the host's reset
notification or from a participant who connects with a newer pass. The
workload replays both orders through the Worker and its real Durable Object
and tldraw WebSockets. Each seed generates link versions and a fixed command
order. A step completes when the expected handshake, close, or ping reply
arrives. The test uses those events to advance, with timeouts for failures.

The **model** tracks the highest link version announced or presented and the
version on each connected socket. A stale pass must be refused. When the
highest version advances, older sockets must close and sockets at the current
version must answer a ping. Reset retries and older reset notifications keep
the version where it is. The trace also reconnects both participants with
current passes after an advance.

Run all workloads or replay one seed. A failed assertion identifies the seed
and the command.

```sh
bun run test test/board-link-model.test.ts
bun run test test/board-link-model.test.ts -t 'seed 42$'
```

The simulated input is notification and connection order. The runtime still
uses its real clock for pass expiration and socket timers. The test observes
protocol behavior across serialized commands with valid signed tokens.
Concurrent arrivals, storage failures and Durable Object restarts are outside
this experiment. A next experiment could restart the room after a reset and
check the model against a stale reconnect after the persisted version loads.

For more on controlling time and faults in a simulator, see
[FoundationDB's simulation documentation](https://github.com/apple/foundationdb/blob/main/documentation/sphinx/source/testing.rst).
For a larger command and state model, see
[QuickCheck's state-machine example](https://hackage.haskell.org/package/quickcheck-state-machine#readme).
