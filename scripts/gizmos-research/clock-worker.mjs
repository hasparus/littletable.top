import { parentPort, workerData } from "node:worker_threads";

async function evaluate({ bytes, current }) {
  if (bytes.length > 512) throw new Error("module exceeds 512 bytes");

  // This lab accepts only short Wasm sections. Excluding memory and tables also covers
  // private declarations that WebAssembly.Module.exports() cannot see.
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error("host imports denied");
  for (let offset = 8; offset < bytes.length; ) {
    const id = bytes[offset];
    const length = bytes[offset + 1];
    if (id === 5) throw new Error("linear memory denied");
    if (![1, 3, 7, 10].includes(id) || length >= 128) throw new Error("unsupported section");
    offset += 2 + length;
  }

  const exports = WebAssembly.Module.exports(module);
  if (exports.length !== 1 || exports[0].name !== "step" || exports[0].kind !== "function") {
    throw new Error("expected a single step function");
  }

  const instance = await WebAssembly.instantiate(module, {});
  const next = instance.exports.step(current);
  if (!Number.isInteger(next) || next < 0 || next > 6)
    throw new Error("result outside clock range");
  return next;
}

try {
  parentPort.postMessage({ value: await evaluate(workerData) });
} catch (error) {
  parentPort.postMessage({ reason: error.message });
}
