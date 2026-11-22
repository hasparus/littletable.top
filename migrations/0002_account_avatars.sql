-- The copy of each account's picture the Worker keeps in R2 (avatars/<hash>,
-- see src/avatars.ts): the SHA-256 of its bytes, or null when the provider
-- names none or it could not be copied. avatar_url stays the provider's
-- address it was copied from, so a later sign-in copies again only when
-- that address changes.
ALTER TABLE accounts ADD COLUMN avatar_hash TEXT;
