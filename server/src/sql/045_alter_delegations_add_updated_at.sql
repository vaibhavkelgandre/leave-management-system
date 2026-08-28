-- Adds `updated_at` to delegations, now that a delegation can be edited.
--
-- The table shipped with only `created_at` because a delegation was
-- write-once: FR-020 gave a manager no way to change one, so "when was this
-- last touched" and "when was this created" could never differ. PATCH
-- /api/delegations/:id makes them differ, and the project convention is that
-- every table carries both.
--
-- Backfilled from `created_at` rather than left NULL: for every row that
-- predates the edit endpoint, the creation time *is* the last time the row
-- changed, so that is the honest value. A NULL would read as "never touched",
-- which is a different claim.
ALTER TABLE delegations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE delegations SET updated_at = created_at WHERE updated_at IS NULL;
