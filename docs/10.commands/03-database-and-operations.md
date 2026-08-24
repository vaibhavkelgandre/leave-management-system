# Database & operations

> Part of [Commands](README.md). Migrations across all three environments, the maintenance scripts, and git.
>
> This is the command list. The *reasoning* — why migrations are manual, why baseline exists, what to do with a
> half-applied run — is in [`docs/8.deployment_and_operations/02-database-and-migrations.md`](../8.deployment_and_operations/02-database-and-migrations.md).

---

## The migration commands

All from `server/`. Every one of them prints the target database before doing anything — **read that line** before
letting it proceed.

| Command | Does | Writes? |
|---|---|---|
| `npm run migrate` | applies every pending file, in order | yes |
| `npm run migrate:status` | applied / pending / edited / orphaned | no |
| `npm run migrate:status -- --verbose` | ...plus the ledger rows | no |
| `npm run migrate:baseline` | lists what it *would* record | no |
| `npm run migrate:baseline -- --yes` | records all files as applied, executing none | yes |
| `npm run migrate:baseline -- --yes --pending-only` | records only the unrecorded ones — recovery | yes |

Note the `--` before any flag: `npm run migrate:baseline --yes` would hand `--yes` to npm, which swallows it, and the
script would never see it. And `baseline` is its own script — there is no `npm run migrate --baseline`.

`migrate:baseline` exists only in `server/package.json`. The root has `migrate` and `migrate:status` as
pass-throughs; anything else must be run from `server/`.

---

## Three environments, three targets

A migration file updates no database by itself. Every new one has to be applied to all three, manually.

### 1. Development — reads `server/.env`

```powershell
cd server; npm run migrate
```

### 2. Test — override the name for the one command

```powershell
$env:DB_NAME = 'leave_management_system_test'; npm run migrate; Remove-Item Env:DB_NAME
```

### 3. Production (Render) — needs the URL *and* SSL

```powershell
$env:DATABASE_URL = '<render-external-database-url>'; $env:DB_SSL = 'true'; npm run migrate:status; Remove-Item Env:DATABASE_URL, Env:DB_SSL
```

```powershell
$env:DATABASE_URL = '<render-external-database-url>'; $env:DB_SSL = 'true'; npm run migrate; Remove-Item Env:DATABASE_URL, Env:DB_SSL
```

Four things about that form, each of which has actually gone wrong here:

- **`DB_SSL=true` is required or it fails with `SSL/TLS required`.** `config/db.js` enables SSL only when
  `NODE_ENV=production` or `DB_SSL=true`, neither of which holds in a local shell. Appending `?sslmode=require` to the
  URL does **not** work — `poolConfig` passes `ssl` explicitly and that wins over the connection string.
- **Use the External URL.** The Internal one only resolves inside Render's own network.
- **Single quotes.** A password containing `$` gets expanded as a variable inside double quotes, silently producing an
  auth failure.
- **Clear both variables afterwards, on the same line.** While `DATABASE_URL` is set, every `npm run migrate` *and*
  every `npm test` in that terminal is aimed at production. The test-database guard now refuses that case — the point
  is not to depend on it.

Verify nothing lingered:

```powershell
Write-Output "[$env:DATABASE_URL] [$env:DB_SSL]"
```

Two empty pairs of brackets means clear.

> ⚠️ **For a database that has data but no ledger, `baseline` — not `migrate`.** Replaying a constraint-narrowing file
> against newer rows fails outright, and idempotent DDL does not save you. This has happened on this project's
> production database; the full account is in
> [`docs/8.deployment_and_operations/02-database-and-migrations.md`](../8.deployment_and_operations/02-database-and-migrations.md).

---

## Maintenance scripts

### Employment-date audit

Read-only. Reports employees with no joining date, and — the urgent list — those whose date has already been paid
against. Writes nothing, so it is safe against any environment.

```powershell
cd server; npm run audit:employment-dates
```

Against production, same variables as a migration:

```powershell
$env:DATABASE_URL = '<render-external-database-url>'; $env:DB_SSL = 'true'; npm run audit:employment-dates; Remove-Item Env:DATABASE_URL, Env:DB_SSL
```

### Demo accounts

Covered in [01-setup.md](01-setup.md#demo-accounts-optional). Against production it needs a third flag it will tell you
about, and it prints the target first.

---

## Inspecting the database directly

```powershell
psql -U postgres -d leave_management_system
```

Useful one-liners — none of these write:

```powershell
psql -U postgres -d leave_management_system -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 5;"
```

```powershell
psql -U postgres -d leave_management_system -c "SELECT u.email, r.role_name, u.status FROM users u JOIN roles r ON r.id = u.role_id ORDER BY r.role_name;"
```

Against production, pass the connection string instead of the flags:

```powershell
psql "<render-external-database-url>" -c "SELECT COUNT(*) FROM users;"
```

---

## Git

The routine sequence after a change:

```powershell
git status --short
```

```powershell
git diff
```

```powershell
git add -A
```

```powershell
git commit -m "<type>(<scope>): <what changed and why>"
```

```powershell
git push origin main
```

Small commits, one feature each. Check what you are about to push:

```powershell
git log --oneline origin/main..HEAD
```

---

## After a deploy

Render deploys on push but **runs no migrations** — that is the manual step above. A deployed frontend hitting an
unmigrated database shows up as a generic load failure ("Unable to load holidays"), which is easy to misdiagnose as a
CORS or API bug. One command answers it:

```powershell
$env:DATABASE_URL = '<render-external-database-url>'; $env:DB_SSL = 'true'; npm run migrate:status; Remove-Item Env:DATABASE_URL, Env:DB_SSL
```

And to confirm the frontend's `/api/*` rewrite is still in place, from the deployed site's own devtools console:

```js
fetch('/api/auth/me').then(r => r.text()).then(console.log)
```

JSON means the rewrite works. HTML means the request is hitting the SPA fallback instead — the rule is missing,
misordered, or the build wasn't refreshed. See
[`docs/8.deployment_and_operations/01-services-and-environment.md`](../8.deployment_and_operations/01-services-and-environment.md).
