// Standalone mode's records in D1 (migrations/): accounts, sessions, boards
// and visits. Every board query that acts for a person names that person,
// so an id from a request never reaches another account's board.

import type { Identity } from "./provider";

export type Account = { avatarUrl: string | null; id: string; name: string };

export type Board = {
  createdAt: number;
  id: string;
  linkVersion: number;
  ownerId: string;
  shareCode: string;
  title: string;
};

export type Session = { account: Account; csrf: string; providerSession: string | null };

export type Listed = { createdAt: number; id: string; shareCode: string; title: string };
// shareCode is null once the owner has reset the link the visitor came by.
export type Visited = { id: string; shareCode: string | null; title: string; visitedAt: number };

type BoardRow = {
  created_at: number;
  id: string;
  link_version: number;
  owner_id: string;
  share_code: string;
  title: string;
};

const board = (row: BoardRow): Board => ({
  createdAt: row.created_at,
  id: row.id,
  linkVersion: row.link_version,
  ownerId: row.owner_id,
  shareCode: row.share_code,
  title: row.title,
});

export class Store {
  constructor(private readonly db: D1Database) {}

  async signIn(identity: Identity, now: number): Promise<Account> {
    await this.db
      .prepare(
        `INSERT INTO accounts (id, name, avatar_url, created_at, signed_in_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (id) DO UPDATE SET name = ?2, avatar_url = ?3, signed_in_at = ?4`,
      )
      .bind(identity.subject, identity.name, identity.avatarUrl, now)
      .run();
    return { avatarUrl: identity.avatarUrl, id: identity.subject, name: identity.name };
  }

  async openSession(input: {
    accountId: string;
    csrf: string;
    expiresAt: number;
    now: number;
    providerSession: string | null;
    tokenHash: string;
  }): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO sessions (token_hash, account_id, provider_session, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.tokenHash,
        input.accountId,
        input.providerSession,
        input.csrf,
        input.now,
        input.expiresAt,
      )
      .run();
  }

  async session(tokenHash: string, now: number): Promise<Session | null> {
    const row = await this.db
      .prepare(
        `SELECT a.id, a.name, a.avatar_url, s.csrf, s.provider_session FROM sessions s
         JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<{
        avatar_url: string | null;
        csrf: string;
        id: string;
        name: string;
        provider_session: string | null;
      }>();
    if (row === null) return null;
    return {
      account: { avatarUrl: row.avatar_url, id: row.id, name: row.name },
      csrf: row.csrf,
      providerSession: row.provider_session,
    };
  }

  async closeSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async createBoard(input: Omit<Board, "linkVersion">): Promise<Board> {
    await this.db
      .prepare(
        "INSERT INTO boards (id, owner_id, title, share_code, link_version, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      )
      .bind(input.id, input.ownerId, input.title, input.shareCode, input.createdAt)
      .run();
    return { ...input, linkVersion: 0 };
  }

  async boardsCreatedSince(ownerId: string, since: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT count(*) AS n FROM boards WHERE owner_id = ? AND created_at > ?")
      .bind(ownerId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async countBoards(ownerId: string): Promise<number> {
    return this.boardsCreatedSince(ownerId, -1);
  }

  async byShareCode(shareCode: string): Promise<Board | null> {
    const row = await this.db
      .prepare("SELECT * FROM boards WHERE share_code = ?")
      .bind(shareCode)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async owned(id: string, ownerId: string): Promise<Board | null> {
    const row = await this.db
      .prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async rename(id: string, ownerId: string, title: string): Promise<Board | null> {
    const row = await this.db
      .prepare("UPDATE boards SET title = ? WHERE id = ? AND owner_id = ? RETURNING *")
      .bind(title, id, ownerId)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async resetLink(id: string, ownerId: string, shareCode: string): Promise<Board | null> {
    const row = await this.db
      .prepare(
        "UPDATE boards SET share_code = ?, link_version = link_version + 1 WHERE id = ? AND owner_id = ? RETURNING *",
      )
      .bind(shareCode, id, ownerId)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM boards WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId)
      .run();
    return result.meta.changes > 0;
  }

  async visit(accountId: string, visited: Board, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO visits (account_id, board_id, share_code, visited_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (account_id, board_id) DO UPDATE SET share_code = ?3, visited_at = ?4`,
      )
      .bind(accountId, visited.id, visited.shareCode, now)
      .run();
  }

  async list(accountId: string): Promise<{ owned: Listed[]; visited: Visited[] }> {
    const [owned, visited] = await this.db.batch([
      this.db
        .prepare(
          "SELECT id, title, share_code, created_at FROM boards WHERE owner_id = ? ORDER BY created_at DESC",
        )
        .bind(accountId),
      this.db
        .prepare(
          `SELECT b.id, b.title, CASE WHEN v.share_code = b.share_code THEN b.share_code END AS share_code,
             v.visited_at FROM visits v JOIN boards b ON b.id = v.board_id
           WHERE v.account_id = ? AND b.owner_id != v.account_id ORDER BY v.visited_at DESC LIMIT 100`,
        )
        .bind(accountId),
    ]);
    return {
      owned: (owned!.results as Record<string, unknown>[]).map((row) => ({
        createdAt: row.created_at as number,
        id: row.id as string,
        shareCode: row.share_code as string,
        title: row.title as string,
      })),
      visited: (visited!.results as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        shareCode: row.share_code as string | null,
        title: row.title as string,
        visitedAt: row.visited_at as number,
      })),
    };
  }
}
