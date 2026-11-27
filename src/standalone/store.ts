import type { Identity } from "./provider";

import { MAX_BOARDS_PER_ACCOUNT, MAX_BOARDS_PER_HOUR } from "../limits";

/** Stores the copied avatar’s SHA-256 alongside its original provider URL. */
export type Account = { avatar: string | null; avatarUrl: string | null; id: string; name: string };

export type Board = {
  createdAt: number;
  firstPageName: string | null;
  hasThumbnail: boolean;
  id: string;
  linkVersion: number;
  ownerId: string;
  shareCode: string;
  title: string;
};

export type Session = { account: Account; csrf: string; providerSession: string | null };

export type Listed = {
  createdAt: number;
  hasThumbnail?: true;
  id: string;
  shareCode: string;
  title: string;
};
/** A visit’s share code is null after the owner resets the link that was used. */
export type Visited = {
  hasThumbnail?: true;
  id: string;
  shareCode: string | null;
  title: string;
  visitedAt: number;
};

type BoardRow = {
  created_at: number;
  first_page_name: string | null;
  has_thumbnail: number;
  id: string;
  link_version: number;
  owner_id: string;
  share_code: string;
  title: string;
};

const board = (row: BoardRow): Board => ({
  createdAt: row.created_at,
  firstPageName: row.first_page_name,
  hasThumbnail: row.has_thumbnail === 1,
  id: row.id,
  linkVersion: row.link_version,
  ownerId: row.owner_id,
  shareCode: row.share_code,
  title: row.title,
});

export type BoardPerson = {
  avatar: string | null;
  id: string;
  name: string;
  role: "manager" | "write";
};

export async function activeSessionExpiry(db: D1Database | undefined, hash: string | undefined) {
  if (db === undefined || hash === undefined) return null;
  const found = await db
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, Math.floor(Date.now() / 1000))
    .first<{ expires_at: number }>();
  return found === null ? null : found.expires_at * 1000;
}

export async function hasActiveSession(db: D1Database | undefined, hash: string | undefined) {
  return (await activeSessionExpiry(db, hash)) !== null;
}

export class Store {
  constructor(
    private readonly db: D1Database,
    private readonly deployment = "",
  ) {}

  async avatarOf(id: string): Promise<{ avatar: string | null; avatarUrl: string | null }> {
    const row = await this.db
      .prepare("SELECT avatar_url, avatar_hash FROM accounts WHERE id = ?")
      .bind(id)
      .first<{ avatar_hash: string | null; avatar_url: string | null }>();
    return { avatar: row?.avatar_hash ?? null, avatarUrl: row?.avatar_url ?? null };
  }

  async signIn(identity: Identity, avatar: string | null, now: number): Promise<Account> {
    await this.db
      .prepare(
        `INSERT INTO accounts (id, name, avatar_url, avatar_hash, created_at, signed_in_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (id) DO UPDATE SET name = ?2, avatar_url = ?3, avatar_hash = ?4, signed_in_at = ?5`,
      )
      .bind(identity.subject, identity.name, identity.avatarUrl, avatar, now)
      .run();
    return { avatar, avatarUrl: identity.avatarUrl, id: identity.subject, name: identity.name };
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
        `SELECT a.id, a.name, a.avatar_url, a.avatar_hash, s.csrf, s.provider_session FROM sessions s
         JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<{
        avatar_hash: string | null;
        avatar_url: string | null;
        csrf: string;
        id: string;
        name: string;
        provider_session: string | null;
      }>();
    if (row === null) return null;
    return {
      account: { avatar: row.avatar_hash, avatarUrl: row.avatar_url, id: row.id, name: row.name },
      csrf: row.csrf,
      providerSession: row.provider_session,
    };
  }

  async closeSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async createBoard(input: Omit<Board, "hasThumbnail" | "linkVersion">) {
    // WARNING: The count and insert have to share a transaction with the creation-history trigger.
    const eligibility = `CASE
      WHEN (SELECT count(*) FROM boards WHERE owner_id = ?1 AND deployment = ?2) >= ?4
        THEN 'too-many-boards'
      WHEN (SELECT count(*) FROM board_creations
        WHERE owner_id = ?1 AND deployment = ?2 AND created_at > ?3 - 3600) >= ?5
        THEN 'too-many-requests'
    END`;
    const scope = [
      input.ownerId,
      this.deployment,
      input.createdAt,
      MAX_BOARDS_PER_ACCOUNT,
      MAX_BOARDS_PER_HOUR,
    ] as const;
    const [created, reason] = await this.db.batch<{
      error?: "too-many-boards" | "too-many-requests";
    }>([
      this.db
        .prepare(
          `INSERT INTO boards (owner_id, deployment, created_at, id, title, share_code, first_page_name)
         SELECT ?1, ?2, ?3, ?6, ?7, ?8, ?9 WHERE (${eligibility}) IS NULL`,
        )
        .bind(...scope, input.id, input.title, input.shareCode, input.firstPageName),
      this.db.prepare(`SELECT ${eligibility} AS error`).bind(...scope),
    ]);
    if (created!.meta.changes > 0)
      return { board: { ...input, hasThumbnail: false, linkVersion: 0 } };
    return { error: reason!.results[0]!.error! };
  }

  async byShareCode(shareCode: string): Promise<Board | null> {
    const row = await this.db
      .prepare("SELECT * FROM boards WHERE share_code = ? AND deployment = ?")
      .bind(shareCode, this.deployment)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async exists(id: string) {
    const row = await this.db
      .prepare("SELECT 1 FROM boards WHERE id = ? AND deployment = ?")
      .bind(id, this.deployment)
      .first();
    return row !== null;
  }

  async owned(id: string, ownerId: string): Promise<Board | null> {
    const row = await this.db
      .prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ? AND deployment = ?")
      .bind(id, ownerId, this.deployment)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async rename(id: string, ownerId: string, title: string): Promise<Board | null> {
    const row = await this.db
      .prepare(
        "UPDATE boards SET title = ? WHERE id = ? AND owner_id = ? AND deployment = ? RETURNING *",
      )
      .bind(title, id, ownerId, this.deployment)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async resetLink(id: string, ownerId: string, shareCode: string): Promise<Board | null> {
    const row = await this.db
      .prepare(
        "UPDATE boards SET share_code = ?, link_version = link_version + 1 WHERE id = ? AND owner_id = ? AND deployment = ? RETURNING *",
      )
      .bind(shareCode, id, ownerId, this.deployment)
      .first<BoardRow>();
    return row === null ? null : board(row);
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM boards WHERE id = ? AND owner_id = ? AND deployment = ?")
      .bind(id, ownerId, this.deployment)
      .run();
    return result.meta.changes > 0;
  }

  async visit(accountId: string, visited: Board, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO visits (account_id, board_id, share_code, visited_at)
         SELECT ?1, id, ?3, ?4 FROM boards WHERE id = ?2 AND deployment = ?5
         ON CONFLICT (account_id, board_id) DO UPDATE SET share_code = ?3, visited_at = ?4`,
      )
      .bind(accountId, visited.id, visited.shareCode, now, this.deployment)
      .run();
  }

  /** Allows the owner and visitors who used the current share link to read the shared thumbnail. */
  async thumbnailAccess(id: string, accountId: string) {
    const row = await this.db
      .prepare(
        `SELECT b.link_version, b.has_thumbnail FROM boards b WHERE b.id = ?1 AND b.deployment = ?3
         AND (b.owner_id = ?2 OR EXISTS (
           SELECT 1 FROM visits v WHERE v.board_id = b.id AND v.account_id = ?2
             AND v.share_code = b.share_code
         ))`,
      )
      .bind(id, accountId, this.deployment)
      .first<{ has_thumbnail: number; link_version: number }>();
    return row === null ? null : { hasThumbnail: row.has_thumbnail === 1, link: row.link_version };
  }

  async markThumbnail(id: string, link: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE boards SET has_thumbnail = 1 WHERE id = ? AND link_version = ? AND has_thumbnail = 0 AND deployment = ?",
      )
      .bind(id, link, this.deployment)
      .run();
  }

  /** What an account that joined this board by link is on it; null if it never joined. */
  async roleOf(accountId: string, boardId: string) {
    const row = await this.db
      .prepare(
        `SELECT v.role FROM visits v JOIN boards b ON b.id = v.board_id
         WHERE v.account_id = ? AND v.board_id = ? AND b.deployment = ?`,
      )
      .bind(accountId, boardId, this.deployment)
      .first<{ role: "manager" | "write" }>();
    return row?.role ?? null;
  }

  /** The accounts that joined a board by link, newest visit first. */
  async people(boardId: string) {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.name, a.avatar_hash, v.role FROM visits v
         JOIN accounts a ON a.id = v.account_id JOIN boards b ON b.id = v.board_id
         WHERE v.board_id = ? AND b.deployment = ? ORDER BY v.visited_at DESC LIMIT 200`,
      )
      .bind(boardId, this.deployment)
      .all<{ avatar_hash: string | null; id: string; name: string; role: "manager" | "write" }>();
    return results.map(
      (row) =>
        ({
          avatar: row.avatar_hash,
          id: row.id,
          name: row.name,
          role: row.role,
        }) satisfies BoardPerson,
    );
  }

  /** Sets a joined account's role; false if that account never joined the board. */
  async setRole(boardId: string, accountId: string, role: "manager" | "write") {
    const result = await this.db
      .prepare(
        `UPDATE visits SET role = ?2 WHERE board_id = ?1 AND account_id = ?3
         AND EXISTS (SELECT 1 FROM boards WHERE id = ?1 AND deployment = ?4)`,
      )
      .bind(boardId, role, accountId, this.deployment)
      .run();
    return result.meta.changes > 0;
  }

  async list(accountId: string): Promise<{ owned: Listed[]; visited: Visited[] }> {
    const [owned, visited] = await this.db.batch([
      this.db
        .prepare(
          "SELECT id, title, share_code, created_at, has_thumbnail FROM boards WHERE owner_id = ? AND deployment = ? ORDER BY created_at DESC",
        )
        .bind(accountId, this.deployment),
      this.db
        .prepare(
          `SELECT b.id, b.title, CASE WHEN v.share_code = b.share_code THEN b.share_code END AS share_code,
             v.visited_at, b.has_thumbnail FROM visits v JOIN boards b ON b.id = v.board_id
           WHERE v.account_id = ? AND b.deployment = ? AND b.owner_id != v.account_id ORDER BY v.visited_at DESC LIMIT 100`,
        )
        .bind(accountId, this.deployment),
    ]);
    return {
      owned: (owned!.results as Record<string, unknown>[]).map((row) => ({
        createdAt: row.created_at as number,
        ...(row.has_thumbnail === 1 ? { hasThumbnail: true as const } : {}),
        id: row.id as string,
        shareCode: row.share_code as string,
        title: row.title as string,
      })),
      visited: (visited!.results as Record<string, unknown>[]).map((row) => ({
        ...(row.share_code !== null && row.has_thumbnail === 1
          ? { hasThumbnail: true as const }
          : {}),
        id: row.id as string,
        shareCode: row.share_code as string | null,
        title: row.title as string,
        visitedAt: row.visited_at as number,
      })),
    };
  }
}
