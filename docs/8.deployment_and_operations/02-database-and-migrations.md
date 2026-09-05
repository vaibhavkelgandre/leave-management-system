# Database & migrations

> Part of [Deployment & Operations](README.md). The design rationale lives in the Database Rules section of
> [`.claude/rules.md`](../../.claude/rules.md); this is the operational procedure.

---

## Migrations never run themselves

A deploy does not touch the schema. Someone runs the migration command, per environment, deliberately.

That's a decision, not an omission. Auto-running on deploy means a bad migration takes down production unattended — on
a tier with no shell to recover from — and the failure arrives while nobody is watching. The cost is that adding a
migration file updates no database on its own, so **a deployed frontend can hit an unmigrated database**, which shows up
as a generic "unable to load X" and is easy to misdiagnose as an API or CORS fault.

`npm run migrate:status` answers that in one line, and is the first thing to run when a deployed page won't load.

## The three commands

| Command | Does | Writes? |
|---|---|---|
| `npm run migrate` | applies every pending file, in order | yes |
| `npm run migrate:status` | applied / pending / edited / orphaned | no |
| `npm run migrate:status -- --verbose` | ...plus the ledger rows | no |
| `npm run migrate:baseline` | lists what it *would* record | no |
| `npm run migrate:baseline -- --yes` | records all files as applied, executing none | yes |
| `npm run migrate:baseline -- --yes --pending-only` | records only the unrecorded ones — recovery | yes |

Every one prints the target database first. Read that line before letting anything proceed.

## Running against Neon from your machine

The database is **Neon**, not Render-managed Postgres — moved there in September 2026 because Render's free
Postgres expires 30 days after creation and is then deleted. Neon's free tier does not expire.

From `server/`, in PowerShell:

```powershell
$env:DATABASE_URL = "<External Database URL>"; $env:DB_SSL = "true"
```

```powershell
npm run migrate:status
```

```powershell
npm run migrate
```

```powershell
Remove-Item Env:DATABASE_URL, Env:DB_SSL
```

⚠️ **Clear the variables when you're done.** They persist for the rest of that terminal session, so the next
`npm run migrate` would silently target production. `DATABASE_URL=... npm run migrate` is bash syntax and does not work
in PowerShell.

⚠️ **Use Neon's direct connection string — the host *without* `-pooler` — for migrations and for the app alike.**
`scripts/migrations.js` takes a session-scoped `pg_advisory_lock`, which a transaction pooler does not hold across
statements, so the guard against two concurrent deploys applying the same pending list would quietly protect nothing.
The pool is `max: 10`, so the pooler buys nothing to offset that.

`DB_SSL=true` is required even though Neon's connection string already carries `sslmode=require`: `config/db.js`
passes `ssl` explicitly and that wins over the URL.

## Baselining a database that predates the ledger

A database holding the full schema but no `schema_migrations` table reads as completely unmigrated — `0 of 37`. That
means the *ledger* is new, not that the tables are missing.

```bash
npm run migrate:baseline            # dry run, lists what it would record
npm run migrate:baseline -- --yes   # writes the rows, executes nothing
```

It refuses once the ledger has rows, because baselining a database that genuinely has migrations outstanding marks them
done so they never run — the one way this system can silently lose a schema change.

### ⚠️ Prefer baseline over migrate on a database that already has data

This is counter-intuitive and was learned the hard way in production. **Idempotent DDL is not the same as safe to
replay against newer data.**

Running `migrate` against the live database — full schema, no ledger — died here:

```text
Applying 033_alter_notifications_add_types.sql...
Migration failed: check constraint "notifications_type_check" of relation "notifications" is violated by some row
```

`033` narrows that constraint to 16 values; `036` widens it to 17 by adding `PROFILE_CREATED`; the running app had
already written rows of that type. Re-imposing `033`'s version against `036`-era rows is a violation, and no amount of
`IF EXISTS` guarding prevents it — the file *is* idempotent and still cannot be replayed.

**Nothing broke**, because each file runs in its own transaction: the `DROP CONSTRAINT` rolled back with the failed
`ADD`, so the table kept its correct constraint. Without that transaction the table would have been left with no type
constraint at all.

### Recovering from a half-applied run

After a failure like the above, the ledger holds the files that did execute and the rest are unrecorded even though the
schema has them. Record the remainder without executing it:

```bash
npm run migrate:baseline -- --pending-only              # dry run
npm run migrate:baseline -- --yes --pending-only        # writes
```

Both flags are required together because this marks files applied that never ran — correct **only** when the schema is
genuinely current. In the case above the failure itself proved that: rows of a type only `036` permits cannot exist
unless `036` ran.

## Adding a migration

1. Next number, zero-padded, in `server/src/sql/` — `038_…` after `037_…`. Zero-padding matters; files are applied in
   lexicographic order and `10` sorts before `2` otherwise.
2. Write it replay-safe by convention (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD`, `ON CONFLICT DO
   NOTHING` on seeds). No longer strictly required now the ledger exists, but it keeps baselining and hand-recovery
   forgiving.
3. Update [`docs/3.db.md`](../3.db/README.md) — a standing rule.
4. Apply to **dev**, **`_test`** (backend tests run against the real schema and will fail without it), and
   **production**.

**Never edit an applied migration.** The ledger stores a SHA-256 of each file and refuses to run if one changed, since
that means environments are silently running different schemas. Checksums are computed on LF-normalised content — this
repo has `core.autocrlf=true`, so raw-byte hashing would make the same file hash differently on Windows and on Render
and *every* run would fail with a meaningless mismatch.

## Reading the ledger

```bash
npm run migrate:status -- --verbose
```

```text
37 of 37 migration(s) recorded as applied.

  2026-08-21 11:29:17  001_enable_pgcrypto.sql  (baselined)
  2026-08-21 11:29:17  002_create_roles.sql  (baselined)
  ...
Nothing pending.
```

`(baselined)` means recorded without executing; a file that really ran shows its duration. That distinction is an
accurate record of how each environment reached its current schema.

Or directly, in any SQL client:

```sql
SELECT filename, applied_at, duration_ms FROM schema_migrations ORDER BY filename;
```
