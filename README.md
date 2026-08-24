# Leave Management System

An HR platform for employee accounts and roles, leave types/balances and the holiday calendar, document upload and
profile verification, payroll and payslips, and in-app notifications.

## Quick start

Two terminals:

```bash
cd server && npm install && npm run dev
```

```bash
cd client && npm install && npm run dev
```

The backend needs a PostgreSQL database before it will start. See [`server/README.md`](server/README.md) for
environment variables, database setup and migrations.

## Running the tests

One command, from the repository root:

```bash
npm test
```

That runs the server suite and then the client suite, in that order, and fails if either does. Either half alone:

```bash
npm run test:server
```

```bash
npm run test:client
```

**Two prerequisites for the server half**, both one-time: `server/.env.test` must point `DB_NAME` at a database whose
name ends in `_test` (the suite refuses to run otherwise, so it can never truncate your development data), and that
database must have the migrations applied — `DB_NAME=<your>_test npm run migrate` from `server/`. A suite failing on
every file with a missing-column error almost always means the `_test` database is a migration behind.

The two suites run sequentially, deliberately: they compete for the same machine, and running them at once has
produced timeouts that look like real failures. The root `package.json` is only a task runner — each half keeps its
own dependencies, so `npm install` still belongs in `server/` and `client/`.

## Demo logins

```bash
npm run seed          # plan only, writes nothing
npm run seed -- --yes # create what's missing
```

Creates three accounts — `demo.hr@`, `demo.manager@`, `demo.employee@example.com` — sharing the password you pass in
`DEMO_PASSWORD` (never defaulted, never committed), wired into a four-level chain under the existing `SUPER_ADMIN`,
plus a pending/approved/rejected leave request each so every role has something to look at.

It is an **ensure** step, not an environment builder: existing users, leave types, holidays, documents and payroll are
never created or modified, because both databases already hold real records. Plan-by-default, idempotent, prints its
target before writing, and needs a second explicit flag to touch anything that looks like production. Full detail —
including how to remove the accounts by hand — is in [`server/README.md`](server/README.md#7-seed-the-demo-logins).

---

## Documentation map

Start with whichever question you're actually asking.

| I want to… | Read |
|---|---|
| **run this locally** | [`server/README.md`](server/README.md) · [`client/README.md`](client/README.md) |
| **look up a command** | [`docs/10.commands/`](docs/10.commands/README.md) — setup, dev servers, tests, migrations per environment, all with placeholder credentials |
| **understand the codebase** | [`docs/architecture/`](docs/architecture/README.md) — 20 files by concern, including end-to-end traces for every module |
| **demo it end to end** | [`docs/6.demo_walkthrough/`](docs/6.demo_walkthrough/README.md) — a script in presentation order |
| **call the API** | [`docs/2.api_documentation/`](docs/2.api_documentation/README.md) |
| **know what a role may do** | [`docs/7.role_permissions_matrix.md`](docs/7.role_permissions_matrix.md) |
| **understand the schema** | [`docs/3.db/`](docs/3.db/README.md) |
| **deploy it, or fix a deployment** | [`docs/8.deployment_and_operations/`](docs/8.deployment_and_operations/README.md) |
| **know what's built and what isn't** | [`docs/1.functional_requirements/`](docs/1.functional_requirements/README.md) · [`docs/4.non_functional_requirements.md`](docs/4.non_functional_requirements.md) |
| **know what's tested** | [`docs/5.test_cases/`](docs/5.test_cases/README.md) |
| **know the security posture** | [`docs/9.security/`](docs/9.security/README.md) — controls, findings, and a pre-merge checklist |
| **change something** | [`.claude/rules.md`](.claude/rules.md) — the project's binding rules |

> 📏 **No document here exceeds 400 lines, and none is trivially short either.** Anything longer is a folder with
> an index; anything that was too short got merged with its neighbours. Both halves of that rule are in
> [`.claude/rules/04-workflow-deployment-and-claude.md`](.claude/rules/04-workflow-deployment-and-claude.md).

## Shape of the thing

```text
client/   React 19 + Vite + Tailwind, React Router, FullCalendar
server/   Express 5 + PostgreSQL, raw parameterized SQL (no ORM)
          routes → validators → controllers → services → repositories
docs/     see the map above
```

| | |
|---|---|
| Roles | `EMPLOYEE`, `MANAGER`, `HR_ADMIN`, singleton `SUPER_ADMIN` |
| Migrations | 38, tracked in a `schema_migrations` ledger, applied manually per environment |
| Tests | 333 server (integration, real Postgres) · 433 client — `npm test` from the root |
| Mail | SendGrid over HTTPS — three flows, each behind a feature flag |
| Storage | Cloudinary, for employee documents |
