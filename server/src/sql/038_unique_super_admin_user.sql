-- Enforces the SUPER_ADMIN singleton in the schema rather than only in the
-- application. authService.registerHrRoot calls existsUserWithRole() before
-- inserting, which is a check-then-insert: two genuinely simultaneous
-- bootstrap requests both pass that check before either commits, and both
-- insert. Same class of bug as the password-reset check-then-insert that
-- uq_password_resets_active_user fixed, and the same remedy — let the index,
-- not the application, be the thing that decides.
--
-- Why a DO block with an interpolated literal instead of a plain partial
-- index: an index predicate must be immutable, so it cannot contain
-- `role_id = (SELECT id FROM roles WHERE role_name = 'SUPER_ADMIN')`. That id
-- comes from gen_random_uuid() in 034_seed_super_admin_role.sql, so it
-- differs per environment, and resolving it here and interpolating it as a
-- literal is the only way to produce a predicate Postgres will accept. Two
-- consequences worth knowing: the index definition is environment-specific
-- (expect a different UUID in each database), and it guards nothing if the
-- SUPER_ADMIN role row is ever deleted and recreated with a fresh id.
--
-- If this file fails with "could not create unique index", the database
-- already holds more than one SUPER_ADMIN user — most likely a bootstrapped
-- account plus one promoted by hand via the UPDATE described in
-- .claude/rules/02-backend-conventions.md. Demote one before re-running; the
-- runner's per-file transaction means nothing is left half-applied.
DO $$
DECLARE
    super_admin_role_id UUID;
BEGIN
    SELECT id INTO super_admin_role_id FROM roles WHERE role_name = 'SUPER_ADMIN';

    IF super_admin_role_id IS NULL THEN
        RAISE EXCEPTION 'SUPER_ADMIN role row is missing - apply 034_seed_super_admin_role.sql first';
    END IF;

    -- IF NOT EXISTS matches on the index name only, which is all that's
    -- needed for a replay: the name is fixed even though the predicate isn't.
    EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_users_single_super_admin
             ON users (role_id) WHERE role_id = %L::uuid',
        super_admin_role_id
    );
END $$;
