import type { GizmoRequest } from "./gizmo-packages";
import type { Pass } from "./pass";

import { normalizeGizmoLink } from "./gizmo-packages";
import { MAX_PEOPLE } from "./limits";

type Entry = {
  id: number;
  url: string;
  status: GizmoRequest["status"];
  installed_url: string | null;
};
export function gizmoProblem(status: number, error: string) {
  return { status, error };
}

export class GizmoRequests {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gizmo_requests (id INTEGER PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL, installed_url TEXT)",
    );
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS gizmo_pending ON gizmo_requests(url) WHERE status = 'pending'",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gizmo_requesters (request_id INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(request_id, sub))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS gizmo_install_links (url TEXT PRIMARY KEY, installed_url TEXT NOT NULL)",
    );
  }

  list(sub: string | null, id: number | null = null) {
    const entries = this.sql.exec<Entry & { name: string }>(
      `SELECT q.id, q.url, q.status, q.installed_url, p.name FROM gizmo_requests q
       JOIN gizmo_requesters p ON p.request_id=q.id
       WHERE (? IS NULL OR p.sub=?) AND (? IS NULL OR q.id=?) ORDER BY q.id DESC, p.rowid`,
      sub,
      sub,
      id,
      id,
    );
    const groups = new Map<number, GizmoRequest>();
    for (const row of entries) {
      let group = groups.get(row.id);
      if (!group) {
        group = {
          id: row.id,
          url: row.url,
          status: row.status,
          requesters: [],
          ...(row.installed_url && { installedUrl: row.installed_url }),
        };
        groups.set(row.id, group);
      }
      group.requesters.push(row.name);
    }
    return [...groups.values()];
  }

  submit(pass: Pass, input: string, changed: () => void) {
    const url = normalizeGizmoLink(input);
    if (!url) return gizmoProblem(400, "Invalid Gizmo link");
    const [prior] = this.sql
      .exec<{ id: number }>(
        `SELECT q.id FROM gizmo_requests q JOIN gizmo_requesters p ON p.request_id=q.id
       WHERE q.url=? AND p.sub=? ORDER BY q.id DESC LIMIT 1`,
        url,
        pass.sub,
      )
      .toArray();
    if (prior) return this.list(pass.sub, prior.id)[0]!;
    const [existing] = this.sql
      .exec<Entry>(
        "SELECT * FROM gizmo_requests WHERE url=? AND status!='declined' ORDER BY id DESC LIMIT 1",
        url,
      )
      .toArray();
    let id = existing?.id;
    if (id === undefined) {
      const [installed] = this.sql
        .exec<{ installed_url: string }>(
          "SELECT installed_url FROM gizmo_install_links WHERE url=? UNION ALL SELECT url FROM gizmo_packages WHERE url=? LIMIT 1",
          url,
          url,
        )
        .toArray();
      if (
        !installed &&
        this.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM gizmo_requests WHERE status='pending'")
          .one().n >= 64
      )
        return gizmoProblem(429, "Too many pending requests");
      id = this.sql
        .exec<{ id: number }>(
          "INSERT INTO gizmo_requests(url, status, installed_url) VALUES (?,?,?) RETURNING id",
          url,
          installed ? "installed" : "pending",
          installed?.installed_url ?? null,
        )
        .one().id;
    } else if (
      this.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM gizmo_requesters WHERE request_id=?", id)
        .one().n >= MAX_PEOPLE
    ) {
      return gizmoProblem(429, "Too many requesters");
    }
    this.sql.exec(
      "INSERT INTO gizmo_requesters(request_id, sub, name) VALUES (?,?,?)",
      id,
      pass.sub,
      pass.name,
    );
    changed();
    return this.list(pass.sub, id)[0]!;
  }

  pending(id: number) {
    return (
      this.sql.exec("SELECT id FROM gizmo_requests WHERE id=? AND status='pending'", id).toArray()
        .length > 0
    );
  }

  decline(id: number) {
    this.sql.exec(
      "UPDATE gizmo_requests SET status='declined' WHERE id=? AND status='pending'",
      id,
    );
  }

  installed(input: string, pinned: string) {
    const url = normalizeGizmoLink(input);
    if (url === null) return;
    this.sql.exec(
      "INSERT INTO gizmo_install_links(url, installed_url) VALUES (?,?) ON CONFLICT(url) DO UPDATE SET installed_url=excluded.installed_url WHERE installed_url!=excluded.installed_url",
      url,
      pinned,
    );
    this.sql.exec(
      "UPDATE gizmo_requests SET status='installed', installed_url=? WHERE url IN (?,?) AND (status!='installed' OR installed_url!=?)",
      pinned,
      url,
      pinned,
      pinned,
    );
  }
}
