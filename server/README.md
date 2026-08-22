# Leave Management System — Backend

Node.js + Express + PostgreSQL (raw SQL via `pg`, no ORM). See [`.claude/rules.md`](../.claude/rules.md) for architecture/coding conventions and [`docs/2.api_documentation.md`](../docs/2.api_documentation/README.md) for the full API reference.

## Prerequisites

- Node.js `>=20 <23`
- A local PostgreSQL server (with permission to `CREATE EXTENSION`, `CREATE DATABASE`)

## 1. Install dependencies

```bash
cd server
npm install
```

## 2. Create the databases

You need **two** databases: one for normal dev use, one for running tests (its name must end in `_test` — the test suite refuses to run otherwise, as a safety guard against accidentally truncating real data).

```sql
CREATE DATABASE leave_management_system;
CREATE DATABASE leave_management_system_test;
```

## 3. Configure environment variables

```bash
cp .env.example .env
cp .env.example .env.test
```

Edit both files. At minimum, fill in:

| Variable | Notes |
|---|---|
| `DB_PASSWORD` | Your local Postgres password |
| `JWT_SECRET` | Any random string (use different values for `.env` vs `.env.test`) |
| `HR_REGISTRATION_CODE` | Shared secret required to self-register the first HR admin |

In `.env.test`, also set `NODE_ENV=test` and `DB_NAME=leave_management_system_test`.

`.env` and `.env.test` are gitignored — never commit them.

## 4. Run migrations

```bash
npm run migrate
```

This applies every file in `server/src/sql/` in order, against the database in **`.env`** — the script always loads plain `.env` (`dotenv.config()` with no path override), it does **not** read `.env.test` even if `NODE_ENV=test` is set. To apply migrations to the test database instead, override `DB_NAME` in the shell (dotenv only fills in variables that aren't already set, so an env var you set yourself takes priority over `.env`):

```bash
# bash
DB_NAME=leave_management_system_test npm run migrate

# PowerShell
$env:DB_NAME = "leave_management_system_test"; npm run migrate; Remove-Item Env:DB_NAME
```

> ℹ️ **The runner keeps a ledger, so it applies only what's new.** A `schema_migrations` table records every applied file with a checksum, so `npm run migrate` against an already-migrated database applies the pending files and skips the rest — you never have to work out which ones are new.
>
> ```bash
> npm run migrate                        # apply everything pending
> npm run migrate:status                 # what is applied, pending, edited or missing
> npm run migrate:status -- --verbose    # ...and print the ledger itself
> ```
>
> `--verbose` lists every recorded file with when it was applied and how long it took, marking rows written by `baseline` as `baselined` rather than timed — so "was this actually executed here, or just recorded?" is answerable without a SQL client.
>
> Each file runs in its own transaction together with its ledger row, so a failure leaves nothing half-applied. Editing a file that already ran aborts the next run, since that would mean two environments running different schemas.

### Baselining a database that predates the ledger

A database holding the full schema but no `schema_migrations` table would otherwise look completely unmigrated. Record its history once, without executing anything:

```bash
npm run migrate:baseline              # dry run - lists what it would record
npm run migrate:baseline -- --yes     # writes the rows
```

Only do this on a database you know is already up to date; it refuses if the ledger has rows. If the database is genuinely behind, run `npm run migrate` instead.

> ⚠️ **On a database that already holds data, prefer `baseline` over `migrate`.** The files are idempotent, but idempotent is not the same as replayable: `033_alter_notifications_add_types.sql` narrows a check constraint that `036` later widens, so replaying 033 against rows created under 036's constraint fails with `is violated by some row`. It fails safely — each file is transactional, so the constraint is left as it was — but the run stops.
>
> If a run died partway like that, the ledger holds the files that did execute and the rest are unrecorded even though the schema has them. Record the remainder without executing it:
>
> ```bash
> npm run migrate:baseline -- --pending-only              # dry run
> npm run migrate:baseline -- --yes --pending-only        # writes the rows
> ```
>
> Both flags are required together because this marks files applied that never ran — correct only when the schema is genuinely current.

## 5. Run the server

```bash
npm run dev     # nodemon, auto-reloads on file changes
npm start       # plain node, for production
```

Server listens on `PORT` from `.env` (default `5001`). Health check: `GET /health`.

## 6. Run tests

```bash
npm test          # watch mode
npm run test:run  # single run
```

Integration tests hit the real `_test` database defined in `.env.test` — they truncate its tables before every test, so never point `.env.test` at a database with real data.

The suite refuses to start unless `NODE_ENV=test`, `DB_NAME` ends in `_test`, **and** any `DATABASE_URL` present also names a `_test` database (`src/tests/integration/helpers/testDatabaseGuard.js`). That third condition matters because `config/db.js` prefers `DATABASE_URL` over the discrete `DB_*` vars whenever it is set — so a connection string left in your shell from a migration run would otherwise silently redirect the truncation.

## 7. Seed the demo logins

```bash
npm run seed                # plan only — prints what it would do, writes nothing
npm run seed -- --yes       # actually create what's missing
```

`DEMO_PASSWORD` must be set, and is deliberately never defaulted and never committed. Set it for the one command:

```bash
DEMO_PASSWORD='choose-something' npm run seed -- --yes
```

```powershell
$env:DEMO_PASSWORD="choose-something"; npm run seed -- --yes
```

### What it creates

Three accounts, on `@example.com` (reserved by RFC 2606, so they can never reach a real inbox), each `ACTIVE` with a `VERIFIED` profile so a reviewer lands in the app rather than the onboarding form:

| Email | Role | Reports to |
|---|---|---|
| `demo.hr@example.com` | `HR_ADMIN` | the existing `SUPER_ADMIN` |
| `demo.manager@example.com` | `MANAGER` | `demo.hr@example.com` |
| `demo.employee@example.com` | `EMPLOYEE` | `demo.manager@example.com` |

All three share the `DEMO_PASSWORD` you supplied. Together with the existing super admin that's a four-level reporting chain, which covers deliverable #2's "at least three levels deep".

It also creates three leave requests for the demo employee — one still pending, one approved, one rejected with a comment — so signing in as the manager shows an approvals queue rather than an empty page. Those go through `submitLeaveRequest`/`decideLeaveRequest`, not raw inserts, so balances, the ledger and the audit trail are correct by construction. Any of the three that can't be created legally (a public holiday on the chosen date, for instance) is skipped and reported, never forced.

### What it deliberately leaves untouched

This is an **ensure** step, not an environment builder. Both databases already contain a reporting hierarchy, leave types, holidays, leave history and salary structures — none of it belongs to this script:

- **Existing users** are never modified. An email that already exists is reported as `exists` and left exactly as it is, in case it's somebody's real account.
- **Leave types** are never created. Creating one backfills a balance row for *every active employee* — a global side effect on people with nothing to do with the demo. The script picks an existing active type instead (needs entitlement ≥ 5 and `requires_document: false`), and skips the demo activity if there isn't one.
- **Holidays** are never created. Holidays are global and feed the working-day calculation, so adding one changes the day count of every future request in the system, for everyone.
- **Documents** are never uploaded. Nothing is put in Cloudinary that no teardown would remove.
- **Payroll** is never generated, and the 200-employee NFR-7 performance dataset is explicitly out of scope — that's a separate job, and one that must never share a database with real records.

### Before running this on production

The demo `HR_ADMIN` account can read **every** employee's PAN, Aadhar, passport and bank details — `GET /users` is company-wide for HR by design, and masking applies only to managers. So a shareable HR password is only acceptable while that database holds no private data.

As of 2026-08-22 the deployed database holds test data only, which is why all three accounts are fine there. **If real employee data ever lands in production, remove the demo HR account or rotate its password out of circulation** — the demo manager and employee logins are unaffected either way, since neither can read another person's sensitive fields.

### Safety

- **Plan by default.** Without `--yes` it reads and reports, writing nothing.
- **The target is printed first**, every time, before any write — same as the migration runner, and for the same reason.
- **Production needs a second flag.** If `NODE_ENV=production` or `DATABASE_URL` is set, `--yes` alone is refused; add `--allow-production` when that's genuinely the intent.
- **Idempotent**, keyed on email. Re-running reports `exists` for each account and adds nothing.

### Removing the demo accounts

Not automated in v1, on purpose: deleting a user cascades across leave requests, balances, ledger entries, documents and slips through a mix of `CASCADE` and `RESTRICT` foreign keys, and guessing about that inside a script whose whole value is being safe is the wrong trade. To remove them by hand, in this order:

```sql
-- inspect first
SELECT id, email FROM users WHERE email LIKE 'demo.%@example.com';

-- then, per id, remove dependents before the user
DELETE FROM audit_logs WHERE leave_request_id IN (SELECT id FROM leave_requests WHERE employee_id = '<id>');
DELETE FROM leave_balance_ledger WHERE user_id = '<id>';
DELETE FROM leave_requests WHERE employee_id = '<id>';
DELETE FROM notifications WHERE recipient_id = '<id>' OR actor_id = '<id>';
DELETE FROM leave_balances WHERE user_id = '<id>';
DELETE FROM users WHERE id = '<id>';
```

Delete the employee first, then the manager, then HR — a user can't be removed while another still reports to them via `manager_id`.

## Project layout

```
src/
  app.js              Express app (middleware, route mounting)
  server.js           HTTP server entrypoint
  config/             DB pool, Google OAuth client
  sql/                Numbered migrations (001_..., applied in order)
  scripts/            runMigrations.js
  repositories/       Raw parameterized SQL queries, one file per table
  services/           Business logic, calls repositories
  controllers/        Thin HTTP layer, calls services
  routes/             Express routers, wires middleware -> validator -> controller
  validators/         Zod schemas + validate.js middleware factory
  middlewares/        Auth, role/scope checks, centralized error handler
  utils/               Error types, response envelope, JWT, password hashing
  tests/integration/  Vitest + Supertest, against a real Postgres test DB
```
