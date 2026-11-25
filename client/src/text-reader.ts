import type { EngineName, TextLine } from "../../src/text-result";
import type { ReadReply, ReadRequest, Size } from "./text-worker";

// WARNING: Tesseract can hang if WebAssembly is blocked, and a WASM reading cannot be interrupted. Terminate the worker on timeout.

export type EngineReading = { engine: EngineName; lines: TextLine[]; ms: number; size: Size };
export type EngineOutcome = EngineReading | { engine: EngineName; failed: string };

// The first reading also fetches and starts the engine (several
// megabytes), so it gets longer.
const FIRST_LIMIT_MS = 120_000;
const LIMIT_MS = 60_000;
const IDLE_MS = 60_000;

export class TextReader {
  #worker: Worker | null = null;
  #started = new Set<EngineName>();
  #idle: ReturnType<typeof setTimeout> | null = null;
  #next = 0;
  #busy: Promise<unknown> = Promise.resolve();

  #spawn(): Worker {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
    this.#worker ??= new Worker(new URL("text-worker.ts", import.meta.url), {
      name: "text",
      type: "module",
    });
    return this.#worker;
  }

  stop(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#started.clear();
  }

  #rest(): void {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.stop(), IDLE_MS);
  }

  // Reads one image with each engine in turn, reporting each as it ends.
  read(
    bytes: ArrayBuffer,
    engines: EngineName[],
    onEngine: (outcome: EngineOutcome) => void,
  ): Promise<null> {
    const run = this.#busy.then(() => this.#run(bytes, engines, onEngine));
    this.#busy = run.catch(() => null);
    return run;
  }

  #run(
    bytes: ArrayBuffer,
    engines: EngineName[],
    onEngine: (outcome: EngineOutcome) => void,
  ): Promise<null> {
    const worker = this.#spawn();
    const id = this.#next++;
    const left = new Set(engines);
    const { promise, resolve } = Promise.withResolvers<null>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ended: boolean) => {
      if (timer !== null) clearTimeout(timer);
      worker.removeEventListener("message", listen);
      worker.removeEventListener("error", crashed);
      if (ended) this.stop();
      else this.#rest();
      resolve(null);
    };
    const fail = (reason: string) => {
      for (const engine of left) onEngine({ engine, failed: reason });
      left.clear();
      finish(true);
    };
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      const engine = [...left][0];
      if (engine === undefined) return;
      timer = setTimeout(
        () => fail("timeout"),
        this.#started.has(engine) ? LIMIT_MS : FIRST_LIMIT_MS,
      );
    };
    const listen = (event: MessageEvent<ReadReply>) => {
      const reply = event.data;
      if (reply.id !== id) return;
      if (reply.type === "done") return finish(false);
      left.delete(reply.engine);
      if (reply.type === "read") {
        this.#started.add(reply.engine);
        onEngine({ engine: reply.engine, lines: reply.lines, ms: reply.ms, size: reply.size });
      } else onEngine({ engine: reply.engine, failed: reply.message });
      arm();
    };
    const crashed = (event: ErrorEvent) => fail(event.message || "worker error");
    worker.addEventListener("message", listen);
    worker.addEventListener("error", crashed);
    arm();
    worker.postMessage({ bytes, engines, id, type: "read" } satisfies ReadRequest, [bytes]);
    return promise;
  }
}
