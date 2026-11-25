-- What an account is on a board it joined by link: "write" (it may draw,
-- as anyone with the link may) or "manager" (it may also connect an
-- assistant to the board). The board's owner sets it and is not listed
-- here; a guest has no account and so no row.
ALTER TABLE visits ADD COLUMN role TEXT NOT NULL DEFAULT 'write' CHECK (role IN ('write', 'manager'));
