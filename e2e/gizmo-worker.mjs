import { BoardRoom as Room } from "../src/board-room.ts";
// oxlint-disable-next-line import/no-default-export -- Wrangler resolves the fetch handler through the module default.
export { default, Limiter } from "../src/index.ts";

export class BoardRoom extends Room {
  fetchGizmoFile(url, init) {
    const base = "https://raw.githubusercontent.com/example/gizmos/" + "a".repeat(40) + "/";
    if (!url.startsWith(base)) return Promise.resolve(new Response(null, { status: 404 }));
    return this.env.ASSETS.fetch(
      new URL("/" + url.slice(base.length), "https://fixtures.test"),
      init,
    );
  }
}
