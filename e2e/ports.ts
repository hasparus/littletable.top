// Where the end-to-end servers listen. E2E_PORT_OFFSET moves all four
// together, so two checkouts on one machine can run their suites at once
// (say 100 in one: 8100, 8101, 8888, 8890).

const offset = Number(process.env.E2E_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset % 10 !== 0 || offset > 50_000) {
  throw new Error(`E2E_PORT_OFFSET must be a multiple of 10 from 0 to 50000, not "${offset}"`);
}

export const PORTS = {
  // e2e/fake-host.ts, the reference host of hosted mode.
  host: 8000 + offset,
  // The Worker in hosted mode.
  hosted: 8788 + offset,
  // The Worker in standalone mode.
  standalone: 8790 + offset,
  // e2e/fake-workos.ts, standalone mode's sign-in provider.
  workos: 8001 + offset,
};

const local = (port: number) => `http://localhost:${port}`;

export const HOST = local(PORTS.host);
export const HOSTED = local(PORTS.hosted);
export const STANDALONE = local(PORTS.standalone);
export const WORKOS = local(PORTS.workos);

// A board's address on the Worker at `origin`, its share code captured.
export const boardAt = (origin: string) =>
  new RegExp(String.raw`^${origin.replaceAll(".", String.raw`\.`)}/b/(\w+)$`, "u");

export const socketOf = (origin: string) => origin.replace(/^http/u, "ws");
