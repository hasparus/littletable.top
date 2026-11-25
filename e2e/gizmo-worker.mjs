import { BoardRoom as Room } from "../src/board-room.ts";
// oxlint-disable-next-line import/no-default-export -- Wrangler resolves the fetch handler through the module default.
export { default, Limiter } from "../src/index.ts";

export class BoardRoom extends Room {
  fetchGizmoFile(url, init) {
    if (url === "https://api.github.com/repos/example/gizmos/commits/main") {
      return Promise.resolve(new Response("a".repeat(40)));
    }
    const file =
      /^https:\/\/raw\.githubusercontent\.com\/(?:example\/gizmos|hasparus\/littletable\.top)\/[a-f\d]{40}\/(gizmos\/.+)$/u.exec(
        url,
      );
    if (!file) return Promise.resolve(new Response(null, { status: 404 }));
    return this.env.ASSETS.fetch(new URL("/" + file[1], "https://fixtures.test"), init);
  }
}
