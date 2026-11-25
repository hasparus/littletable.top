// Compare the list page's fetch sequences with a fixed per-request delay.
// Run with bun scripts/bench-board-list.ts [delay-ms].
const delay = Number(process.argv[2] ?? 50);
const me = { account: { avatar: null, id: "bench", name: "Bench" }, csrf: "fixture" };
const lists = { owned: [{ id: "one", title: "Example", shareCode: "one" }], visited: [] };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    await Bun.sleep(delay);
    const path = new URL(request.url).pathname;
    return Response.json(path === "/me" ? me : path === "/boards" ? lists : { ...me, ...lists });
  },
});

async function measure(paths: string[]) {
  const start = performance.now();
  for (const path of paths) await (await fetch(new URL(path, server.url))).json();
  return performance.now() - start;
}

try {
  const before: number[] = [];
  const after: number[] = [];
  for (let i = 0; i < 21; i++) {
    const baseline = await measure(["/me", "/boards"]);
    const combined = await measure(["/combined"]);
    if (i > 0) {
      before.push(baseline);
      after.push(combined);
    }
  }
  for (const [label, samples] of [
    ["sequential", before],
    ["combined", after],
  ] as const) {
    samples.sort((a, b) => a - b);
    console.log(label, "median ms", ((samples[9]! + samples[10]!) / 2).toFixed(1));
  }
} finally {
  server.stop(true);
}
