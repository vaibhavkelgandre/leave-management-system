# Commands

> Every command needed to run, test, migrate and operate this project, in one place. A lookup table rather than a
> tutorial — each entry says what the command does and links to the document that explains *why* where that matters.
>
> **No real credentials appear anywhere in this folder.** Anything secret is written as a `<placeholder>`; fill it from
> `server/.env.example` (which lists every variable with its own notes) or from the Render dashboard.

---

| File | Covers |
|---|---|
| [01-setup.md](01-setup.md) | prerequisites, installing, the two databases, environment files, first migration, demo data |
| [02-running-and-testing.md](02-running-and-testing.md) | dev servers, the test suite, lint, production build |
| [03-database-and-operations.md](03-database-and-operations.md) | migrations across all three environments, the audit script, git, deployment checks |

Related, and deliberately not duplicated here:

- [`docs/8.deployment_and_operations`](../8.deployment_and_operations/README.md) — why migrations are manual, how the
  two Render services find each other, and the troubleshooting decision tree.
- [`server/README.md`](../../server/README.md) — the backend's own setup notes and layer-by-layer architecture.
- [`server/.env.example`](../../server/.env.example) — the authoritative list of environment variables. Every
  variable's meaning, default and trap is commented there, not here.

---

## Shell conventions used throughout

Commands are given for **PowerShell**, which is what this project is developed on. Two differences from bash bite
constantly:

- **PowerShell has no inline `VAR=value command` prefix.** `DB_NAME=x npm run migrate` is bash and fails here. Set the
  variable, run the command, then clear it — the one-line `;` form does all three and still clears if the command
  fails:

  ```powershell
  $env:DB_NAME = 'leave_management_system_test'; npm run migrate; Remove-Item Env:DB_NAME
  ```

- **Windows PowerShell 5.1 has no `&&`.** Use `;` to chain unconditionally, or `; if ($?) { ... }` to chain on success.

Use **single quotes** for any value that could contain `$` or `&` — a password or a connection string. Double quotes
expand `$name` as a variable, which mangles the value silently rather than erroring.

---

## The 60-second path

A fresh clone to a running app, assuming Postgres is already installed:

```powershell
cd server; npm install; cd ../client; npm install; cd ..
```

Create the two databases and both `.env` files ([01-setup.md](01-setup.md)), then:

```powershell
cd server; npm run migrate
```

```powershell
$env:DB_NAME = 'leave_management_system_test'; npm run migrate; Remove-Item Env:DB_NAME
```

Two terminals, one each:

```powershell
cd server; npm run dev
```

```powershell
cd client; npm run dev
```

The app is at `http://localhost:5173`, the API at `http://localhost:5001/api`.
