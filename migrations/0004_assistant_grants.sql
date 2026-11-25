CREATE TABLE assistant_clients (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  PRIMARY KEY (account_id, client_id)
);

CREATE TABLE assistant_grants (
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  access TEXT NOT NULL CHECK (access IN ('off', 'read', 'write')),
  revision INTEGER NOT NULL,
  PRIMARY KEY (account_id, client_id, board_id),
  FOREIGN KEY (account_id, client_id) REFERENCES assistant_clients(account_id, client_id) ON DELETE CASCADE
);
CREATE INDEX assistant_grants_by_board ON assistant_grants(board_id);
