import type { BoardGrant } from "../room-contract";

export type AssistantAccess = "off" | "read" | "write";

type AccessRow = {
  access: AssistantAccess;
  board: string;
  revision: number;
  role: "owner" | "shaman";
  title: string;
};

// A reset join link invalidates the manager's access until the owner shares the new link.
const ELIGIBLE = `(b.owner_id = ?1 OR (v.role = 'shaman' AND v.share_code = b.share_code))`;
const VISIT = "LEFT JOIN visits v ON v.board_id = b.id AND v.account_id = ?1";
const GRANT = "g.board_id = b.id AND g.account_id = ?1 AND g.client_id = ?2";

export class AssistantGrants {
  constructor(private readonly db: D1Database) {}

  async register(account: string, client: string) {
    await this.db
      .prepare(`INSERT OR IGNORE INTO assistant_clients (account_id, client_id)
      SELECT id, ?2 FROM accounts WHERE id = ?1`)
      .bind(account, client)
      .run();
  }

  async clients(account: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT client_id FROM assistant_clients WHERE account_id = ? ORDER BY client_id")
      .bind(account)
      .all<{ client_id: string }>();
    return results.map((row) => row.client_id);
  }

  async boards(account: string, client: string): Promise<AccessRow[]> {
    const { results } = await this.db
      .prepare(`SELECT b.id AS board, b.title,
      COALESCE(g.access, 'off') AS access, COALESCE(g.revision, 0) AS revision,
      CASE WHEN b.owner_id = ?1 THEN 'owner' ELSE 'shaman' END AS role
      FROM boards b ${VISIT} LEFT JOIN assistant_grants g ON ${GRANT}
      WHERE ${ELIGIBLE} ORDER BY b.title, b.id`)
      .bind(account, client)
      .all<AccessRow>();
    return results;
  }

  async grants(account: string, client: string): Promise<BoardGrant[]> {
    const { results } = await this.db
      .prepare(`SELECT b.id AS board, b.title, g.access, g.revision,
      CASE WHEN b.owner_id = ?1 THEN 'owner' ELSE 'shaman' END AS role
      FROM assistant_grants g JOIN boards b ON ${GRANT} ${VISIT}
      WHERE ${ELIGIBLE} AND g.access != 'off' ORDER BY b.title, b.id LIMIT 100`)
      .bind(account, client)
      .all<AccessRow & { access: "read" | "write" }>();
    return results.map(({ access, board, revision, role, title }) => ({
      access,
      board,
      grant: 0,
      role,
      standalone: { account, client, revision },
      title,
    }));
  }

  async set(account: string, client: string, board: string, access: AssistantAccess) {
    const result = await this.db
      .prepare(`INSERT INTO assistant_grants
      (account_id, client_id, board_id, access, revision)
      SELECT ?1, ?2, b.id, ?4, 1 FROM boards b ${VISIT}
      JOIN assistant_clients c ON c.account_id = ?1 AND c.client_id = ?2
      WHERE b.id = ?3 AND (${ELIGIBLE} OR ?4 = 'off')
      ON CONFLICT (account_id, client_id, board_id) DO UPDATE SET
        access = excluded.access, revision = assistant_grants.revision + 1`)
      .bind(account, client, board, access)
      .run();
    return result.meta.changes > 0;
  }

  async revokeManager(account: string, board: string) {
    await this.db
      .prepare(`UPDATE assistant_grants SET access = 'off', revision = revision + 1
      WHERE account_id = ? AND board_id = ? AND access != 'off'`)
      .bind(account, board)
      .run();
  }

  async admits(grant: BoardGrant) {
    const { standalone } = grant;
    if (!standalone) return false;
    const row = await this.db
      .prepare(`SELECT 1 FROM boards b ${VISIT}
      JOIN assistant_grants g ON ${GRANT}
      WHERE b.id = ?3 AND ${ELIGIBLE} AND g.access = ?4 AND g.revision = ?5`)
      .bind(standalone.account, standalone.client, grant.board, grant.access, standalone.revision)
      .first();
    return row !== null;
  }
}
