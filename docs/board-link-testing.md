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
Concurrent arrivals and storage failures are outside the seeded test. A
separate Worker test forces a room restart after reset, then checks an old
pass before a current pass can advance the room version. Workerd logs
`test restart` when it aborts the instance. The test expects that error.

```sh
bun run test test/board-link-model.test.ts -t 'room restart'
```

The standalone demonstration controls logical time and event order. It uses
a toy board. With seed 43, a connection starts before a reset and finishes
after a restart. The first command should print `PASS`, and the
intentionally broken variant should print `FAIL` and exit with status 1.

```sh
bun scripts/demo-board-link-simulation.ts 43
bun scripts/demo-board-link-simulation.ts 43 stale-snapshot
```

For more on controlling time and faults in a simulator, see
[FoundationDB's simulation documentation](https://github.com/apple/foundationdb/blob/main/documentation/sphinx/source/testing.rst).
For a larger command and state model, see
[QuickCheck's state-machine example](https://hackage.haskell.org/package/quickcheck-state-machine#readme).

## Multiplayer view and expiry regressions

Two fixed schedules send real tldraw page edits and view summons, close one
of two tabs for the same viewer, abort the room twice, and reconnect in
opposite orders. At each handshake the client checks its page snapshot
against the edits the writer committed. At each summon it checks the HTTP
status and each live socket's entire ordered delivery history, including
two intentional identical summons. A ping/pong fences delivery on each
socket. These checks end at the wire, before the browser applies the camera.

```sh
bun run test test/board-view-lifecycle.test.ts
bun run test test/board-view-lifecycle.test.ts -t 'schedule 1$'
```

The public-board expiry alarm changes the paint order of surviving strokes.
Replay the regression with:

```sh
bun run test test/public-stacking.test.ts
```

The fixture stacks red beneath blue inside a 49-hour-old group and places a
green stroke above the group. All three fresh strokes overlap. Before the alarm,
their back-to-front order is red, blue, green. After one production alarm,
SQLite contains the same strokes in green, blue, red paint order. The sweep
assigns fresh indices above the highest page sibling as it iterates surviving
children. The test derives paint order independently by walking parent groups
and sorting siblings by their tldraw index. Fixture setup, initial order, alarm
execution and survival checks run normally. Only the final equality is marked
`it.fails`. Remove `.fails` to see the failing diff or to land a fix.
