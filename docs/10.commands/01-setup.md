# First-time setup

> Part of [Commands](README.md). Run these once per machine. Every secret is a `<placeholder>` — fill it from
> [`server/.env.example`](../../server/.env.example), which documents what each variable is for.

---

## Prerequisites

| Need | Why |
|---|---|
| **Node.js ≥ 20, < 23** | pinned in `server/package.json`'s `engines`. Node 23 is untested here |
| **PostgreSQL** (local) | with rights to `CREATE DATABASE` and `CREATE EXTENSION` — the migrations need `pgcrypto` for `gen_random_uuid()` |
| **Git** | |

Check what you have:

```powershell
node --version; npm --version; psql --version
```

Cloudinary and SendGrid accounts are **optional locally**. Without them, document upload fails and email is
console-logged instead of sent — everything else works.

---

## Install

Dependencies live in the two halves, never at the root. The root `package.json` is a task runner with no dependencies
of its own.

```powershell
cd server; npm install
```

```powershell
cd client; npm install
```

---

## Create the two databases

You need **two**: one for development, one for tests. The test database's name must end in `_test` — the suite refuses
to start otherwise, which is what stops it truncating your development data.

```powershell
psql -U postgres -c "CREATE DATABASE leave_management_system;"
```

```powershell
psql -U postgres -c "CREATE DATABASE leave_management_system_test;"
```

If `psql` prompts for a password and you'd rather not type it per command, set it for the session and clear it after:

```powershell
$env:PGPASSWORD = '<your-postgres-password>'; psql -U postgres -c "SELECT version();"; Remove-Item Env:PGPASSWORD
```

---

## Environment files

Copy each example, then fill in the blanks. Neither `.env` is committed.

```powershell
Copy-Item server/.env.example server/.env
```

```powershell
Copy-Item client/.env.example client/.env
```

### `server/.env` — the minimum to boot

```ini
DB_PASSWORD=<your-postgres-password>
JWT_SECRET=<a-long-random-string>
HR_REGISTRATION_CODE=<any-value-you-choose>
```

Generate a `JWT_SECRET` rather than inventing one:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Everything else in that file already has a working local default. Leave `DATABASE_URL=` **blank** — it takes
precedence over every `DB_*` variable whenever it is set, so a stray value aims your whole local setup at whatever it
names.

### `server/.env.test`

Not shipped as an example, because it holds a database name that must differ per machine. Start from your `.env` so
nothing is missing, then override five keys:

```powershell
Copy-Item server/.env server/.env.test
```

```ini
NODE_ENV=test
DB_NAME=leave_management_system_test
DATABASE_URL=
SENDGRID_API_KEY=
MAIL_FROM=
```

The blank values are not decoration:

- **`DATABASE_URL=`** neutralises a value left over in your shell from a production migration, before the
  test-database guard even looks at it. `config/db.js` prefers that variable over every `DB_*` one whenever it is set,
  so without this the suite's `TRUNCATE` would follow it.
- **Blank mail credentials** matter because `server/.env` leaks into the test process for any key *absent* from
  `.env.test` — a few config modules call `dotenv.config()` on import without `override`. A missing blank here means a
  test touching a mail path could send **real email**. `sendMail` also hard-returns when `NODE_ENV === "test"`, so this
  is the second of two guards, not the only one.

### `client/.env`

The example's defaults work as-is for local development. Only `VITE_API_URL` matters, and it already points at
`http://localhost:5001/api`.

---

## Apply the migrations

Both databases need them. The development one reads `.env`:

```powershell
cd server; npm run migrate
```

The test one needs `DB_NAME` overridden for the single command:

```powershell
$env:DB_NAME = 'leave_management_system_test'; npm run migrate; Remove-Item Env:DB_NAME
```

Confirm both, one after the other:

```powershell
npm run migrate:status
```

```powershell
$env:DB_NAME = 'leave_management_system_test'; npm run migrate:status; Remove-Item Env:DB_NAME
```

> A test suite failing on *every* file with a missing-column error almost always means the `_test` database is a
> migration behind. That is the first thing to check.

---

## Demo accounts (optional)

`npm run seed` adds one login per role — employee, manager, HR — so a reviewer can see the difference between them.
It is an *ensure* step: it never creates a leave type or a holiday (both are global and would affect real employees),
and never modifies an existing row.

It is a **dry run by default** and prints the target database before writing anything:

```powershell
$env:DEMO_PASSWORD = '<a-password-you-choose>'; npm run seed; Remove-Item Env:DEMO_PASSWORD
```

Once the plan looks right, apply it:

```powershell
$env:DEMO_PASSWORD = '<a-password-you-choose>'; npm run seed -- --yes; Remove-Item Env:DEMO_PASSWORD
```

`DEMO_PASSWORD` is deliberately never defaulted — a seed script that invents a password nobody chose is a credential
nobody knows they published. There is **no teardown**; removing these accounts is manual, and the steps are in
[`server/README.md`](../../server/README.md).
