ALTER TABLE boards ADD COLUMN first_page_name TEXT;

-- Deleting a board leaves its creation in the rolling hourly allowance.
CREATE TABLE board_creations (
  board_id TEXT PRIMARY KEY,
  deployment TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX board_creations_by_owner ON board_creations (deployment, owner_id, created_at);

INSERT INTO board_creations (board_id, deployment, owner_id, created_at)
SELECT id, deployment, owner_id, created_at FROM boards WHERE created_at > unixepoch() - 3600;

-- Record the creation in the same SQLite transaction as the board itself.
CREATE TRIGGER record_board_creation AFTER INSERT ON boards
BEGIN
  DELETE FROM board_creations
  WHERE deployment = NEW.deployment AND owner_id = NEW.owner_id
    AND created_at <= NEW.created_at - 3600;
  INSERT INTO board_creations (board_id, deployment, owner_id, created_at)
  VALUES (NEW.id, NEW.deployment, NEW.owner_id, NEW.created_at);
END;
