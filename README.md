# Leave Management System

An HR platform for employee accounts and roles, leave types/balances and the holiday calendar, document upload and
profile verification, payroll and payslips, and in-app notifications.

## Live deployment

**<https://leave-management-system-1-6t22.onrender.com>**

Sign in with any of the [demo logins](#demo-logins) below. The frontend is a Render static site, the API a Render
web service, and the database is Neon Postgres; documents live in Cloudinary and mail goes out through Brevo.

Two things to expect, both properties of the free hosting rather than of the app:

- **The first request takes ~30 seconds.** The API sleeps when idle and has to wake up. Everything after that is
  fast, so a hanging first click is not a broken app.
- **Emails may land in spam.** The sender is a `@gmail.com` address, and `gmail.com` cannot be domain-authenticated
  by anyone except Google, so SPF/DKIM never align for it. This affects the password-reset and invite links. The
  real fix needs a domain with DNS access —
  see [the troubleshooting notes](docs/8.deployment_and_operations/03-troubleshooting.md).

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

## Setting up a fresh deployment

A brand-new deployment has no accounts at all, so nobody can sign in. Open the app and the sign-in page says so, with
a link to `/register` — fill in your name, email and password plus the `HR_REGISTRATION_CODE` from the server's
environment, and you get the single `SUPER_ADMIN` account that owns the deployment. Creating it signs you in.

From there everything is invitation-driven: invite an HR admin first (the reporting rules let the super admin manage
an HR admin and nobody else), and they build out managers and employees from their own branch. Leave types and
holidays can be created by either role, in any order — adding a leave type backfills a balance row for everyone who
already exists.

`/register` is reachable only while no super admin exists; afterwards it redirects to sign-in, and the endpoint itself
answers `409`. There is exactly one super admin per deployment, enforced by a partial unique index rather than only by
a check, so two simultaneous attempts resolve to one success and one refusal.

> One deployment serves one organisation. There is no tenant column in the schema, so several organisations cannot
> share an instance — each needs its own deployment and its own registration code.

---

## Demo logins

Reviewers can sign in as any of the three roles and see the difference immediately:

| Email | Role | Sees |
|---|---|---|
| `demo.hr@example.com` | HR&nbsp;admin | their own branch, payroll, reports, profile verification, override |
| `demo.manager@example.com` | Manager | their team's approvals, team calendar, delegation |
| `demo.employee@example.com` | Employee | their own balances, requests and payslips |

All three share the password **`Pass@123`**.

These are deliberately the *only* published credentials, and they are safe to publish because this deployment holds
test data only. They are also `@example.com` — reserved by RFC 2606, so no mail can ever be delivered to them, which
is why the reset flow is not a way back in if the password is changed. Use `--reset-passwords` below instead.

To create them:

```bash
npm run seed          # plan only, writes nothing
npm run seed -- --yes # create what's missing
```

```bash
npm run seed -- --yes --reset-passwords   # re-set the three demo passwords to DEMO_PASSWORD
```

The password comes from `DEMO_PASSWORD`, which is never defaulted and never committed — set it for the one command.
`--reset-passwords` is the single exception to "never modify an existing row" and is scoped to exactly those three
addresses; it exists because a demo password nobody wrote down is otherwise unrecoverable on an address that cannot
receive mail. Without the flag, a re-run still leaves every existing account untouched.

The accounts are wired into a four-level chain under the existing `SUPER_ADMIN`, plus a pending/approved/rejected
leave request each so every role has something to look at.

It is an **ensure** step, not an environment builder: existing users, leave types, holidays, documents and payroll are
never created or modified, because both databases already hold real records. Plan-by-default, idempotent, prints its
target before writing, and needs a second explicit flag to touch anything that looks like production. Full detail —
including how to remove the accounts by hand — is in [`server/README.md`](server/README.md#7-seed-the-demo-logins).

---

## Documentation map

Start with whichever question you're actually asking.

| I want to… | Read |
|---|---|
| **read the project report** | [`docs/0.project_report/`](docs/0.project_report/README.md) — the submission document: the brief answered requirement by requirement, the authorization model, the seven design questions, and the known limitations |
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
| Migrations | 44, tracked in a `schema_migrations` ledger, applied manually per environment |
| Tests | 444 server (integration, real Postgres) · 468 client — `npm test` from the root |
| Mail | SendGrid over HTTPS — three flows, each behind a feature flag |
| Storage | Cloudinary, for employee documents |
