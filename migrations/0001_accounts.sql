-- Standalone mode's records. Live board state stays in each board's Durable
-- Object; this database knows who owns which board and who visited it.

-- One row per person who has signed in. The id is the sign-in provider's
-- user id; name and avatar are refreshed from the provider at each sign-in.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  signed_in_at INTEGER NOT NULL
);

-- A signed-in browser. The cookie holds a random token; only its SHA-256 is
-- kept. csrf is the token state-changing requests must echo.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider_session TEXT,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_account ON sessions (account_id);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  link_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX boards_by_owner ON boards (owner_id, created_at);

-- A signed-in person's visit to someone else's board, for their list, with
-- the link they came by: once the owner resets it, the list stops linking.
CREATE TABLE visits (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
  share_code TEXT NOT NULL,
  visited_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, board_id)
);
CREATE INDEX visits_by_account ON visits (account_id, visited_at);
