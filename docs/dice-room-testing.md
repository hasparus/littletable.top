# Seeded dice room experiment

Little Table already uses an animation seed to reproduce a throw's physics
across browsers. The experiment adds a separate **workload seed** to replay
the same sequence of roll requests at the same logical times. The harness
drives the real `BoardRoom` Durable Object and SQLite in workerd. It sets
`Date.now()` before each call, so the test can exercise 499 ms and 500 ms
without waiting or relying on the speed of the test runner.

The **model** is an append-only list of accepted commands. A participant is
eligible 500 ms after their last accepted roll. The visible history is the
last 50 accepted commands in order. At each step the test compares the roll
response and room history with these rules. The workload includes both
immediate retries and more than 50 accepted rolls. Each failure identifies
the workload seed and command.

Run all workloads, or replay one named case:

```sh
bun run test test/dice-room-model.test.ts
bun run test test/dice-room-model.test.ts -t 'seed 42$'
```

The result comparison covers timestamps, participants and dice pools. Dice
values and animation seeds still use live entropy and are outside the model.
The commands run serially against a fresh room with valid passes. This leaves
HTTP validation, WebSocket delivery, restarts and concurrent requests to
other tests.

A next experiment would generate link resets and rolls made with old and new
passes. The model could track the current link version alongside its journal
and check that a stale pass cannot change the log.

## Further reading

- FoundationDB controls simulated time and faults across an entire cluster.
  [FoundationDB simulation documentation](https://github.com/apple/foundationdb/blob/main/documentation/sphinx/source/testing.rst)
- QuickCheck's state-machine approach expresses expected behavior as commands,
  transitions and checks on responses.
  [QuickCheck state-machine example](https://hackage.haskell.org/package/quickcheck-state-machine#readme)
