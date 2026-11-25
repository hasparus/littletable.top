ALTER TABLE boards ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK (has_thumbnail IN (0, 1));
