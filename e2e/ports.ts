const offset = Number(process.env.E2E_PORT_OFFSET ?? 0);
if (!Number.isInteger(offset) || offset < 0 || offset % 10 !== 0 || offset > 50_000) {
  throw new Error(`E2E_PORT_OFFSET must be a multiple of 10 from 0 to 50000, not "${offset}"`);
}

/** Applies E2E_PORT_OFFSET to all servers for concurrent local runs. */
export const PORTS = {
  host: 8000 + offset,
  hosted: 8788 + offset,
  standalone: 8790 + offset,
  workos: 8001 + offset,
};

const local = (port: number) => `http://localhost:${port}`;

export const HOST = local(PORTS.host);
export const HOSTED = local(PORTS.hosted);
export const STANDALONE = local(PORTS.standalone);
export const WORKOS = local(PORTS.workos);

export const boardAt = (origin: string) =>
  new RegExp(String.raw`^${origin.replaceAll(".", String.raw`\.`)}/b/(\w+)$`, "u");

export const socketOf = (origin: string) => origin.replace(/^http/u, "ws");
