-- Track deletion attempts before room retirement, and preserve cleanup ownership after D1 removal.
CREATE TABLE pending_board_deletions (
  id TEXT PRIMARY KEY,
  deployment TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pending_board_deletions_by_owner ON pending_board_deletions (deployment, owner_id);
