ALTER TABLE boards ADD COLUMN deployment TEXT NOT NULL DEFAULT '';
CREATE INDEX boards_by_deployment_and_owner ON boards (deployment, owner_id, created_at);
