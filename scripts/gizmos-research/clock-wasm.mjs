import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

import { increment, neverFinishes, requiresHost, requiresMemory } from "./clock-fixtures.mjs";

// Only the bundled demonstration modules are accepted by this entry point.
async function run(bytes, current, deadlineMs = 1500) {
  const worker = new Worker(new URL("./clock-worker.mjs", import.meta.url), {
    workerData: { bytes, current },
  });
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => resolve({ reason: "deadline exceeded" }), deadlineMs);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited without a result (${code})`)));
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}

const cases = [
  ["advance 3 of 6", increment, 3, { value: 4 }],
  ["advance 6 of 6", increment, 6, { reason: "result outside clock range" }],
  ["request a host function", requiresHost, 3, { reason: "host imports denied" }],
  ["declare private memory", requiresMemory, 3, { reason: "linear memory denied" }],
  ["rule never returns", neverFinishes, 3, { reason: "deadline exceeded" }],
];

for (const [name, bytes, current, expected] of cases) {
  assert.ok(WebAssembly.validate(bytes), `invalid fixture for ${name}`);
  const result = await run(bytes, current);
  assert.deepEqual(result, expected);
  console.log(name, "→", result.value ?? result.reason);
}
