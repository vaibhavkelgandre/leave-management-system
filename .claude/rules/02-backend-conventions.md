# Database, auth, secrets, API format & testing

> Part of the [project rules](../rules.md). These are binding, not advisory.

---

## Database rules & the migration ledger

### 🗄️ Database Rules

- Use PostgreSQL.
- Use raw SQL with **parameterized queries** (no string concatenation — prevents SQL injection).
- Use `UUID DEFAULT gen_random_uuid()` for primary keys.
- Use foreign keys where appropriate.
- Every table needs `created_at` and `updated_at`.
- Store SQL scripts in `src/sql`.
- Migrations are numbered sequentially and **never edited after being applied** — now enforced rather than merely asked for: the runner stores a SHA-256 of every applied file and refuses to run if one changed.
  Current latest is `042_alter_holiday_adjustment_reasons.sql` → next migration must start at `043_...`.

> 🗓️ **Writing a holiday recounts live leave, and that is the whole point of `holidayService.js` taking an `actorId`.** `leave_requests.working_days` is computed once at submit and never recomputed, so a holiday declared *after* a request was approved left the employee charged for a day that had become a holiday — five days deducted for a Mon–Fri leave with a Wednesday holiday added later, permanently one day short. Deleting a holiday in error under-charged the same way. `create`/`update`/`delete` now call `reconcileWorkingDaysForHolidayChange` (`leaveRequestService.js`) and return `{ holiday, adjusted }` / `{ adjusted }`. Five things about it are load-bearing:
> 1. **`SUBMITTED` and `APPROVED` only.** Every other status has already released its days, so recounting one would move a balance for a request that no longer affects one — and it would do so invisibly, since nobody looks at a withdrawn request again.
> 2. **The delta goes to `pending_delta` for `SUBMITTED` and `taken_delta` for `APPROVED`, never both.** A submitted request holds its days in pending; an approved one has moved them to taken. Adjusting the wrong column corrupts the balance in a way that is very hard to see, because both sums still look plausible on their own.
> 3. **The balance moves by an append (`HOLIDAY_ADJUSTMENT`, migration 042), never an edit.** `working_days` on the request *is* updated in place — it is a derived cache — but `leave_balance_ledger` exists precisely so a correction is a new row (NFR-2: the number must agree with the history that produced it). Nothing in `audit_logs` is touched either: the leave really was submitted and decided when it was, and that trail is append-only about *decisions*.
> 4. **An update reconciles the union of the old and new ranges.** Reconciling only the new dates misses that the old date stopped being a holiday, which is a silent under-count in the opposite direction.
> 5. **Any `ACTIVE` payslip for an affected month is voided**, because payroll sums the stored `working_days` of approved leave. This is why `voidSlipsInconsistentWithEmploymentDates` was renamed `voidInconsistentSlips` and now compares the slip's `lop_days` against a live `findLopWorkingDays` as well as its employed days — a recount is a second, unrelated way for a slip to stop agreeing with reality.
>
> HR is told how many requests were recounted (`HolidaysPage.jsx`'s amber notice) and each affected employee gets a `LEAVE_DAYS_ADJUSTED` notification quoting **both** figures — unlike the pay-affecting notifications, which deliberately quote none. The difference is deliberate: a leave day count isn't sensitive the way a salary is, and "your leave was recounted" without saying from what to what isn't actionable.

> ⚖️ **A leave type's definition is a snapshot for anyone who already has a balance row, and changing that has to be opt-in and reported.** `leave_balances.entitlement` is copied when the row is created, so editing the type used to change nothing for existing rows — deliberate (retroactively rewriting an entitlement changes what people have already been shown) but silent: raising Annual Leave from 12 to 15 in June left January's hires on 12 all year while July's got 15, same type, same year, nobody told. `PATCH /leave-types/:id` now takes **`applyToCurrentYear`** (default `false` — the old behaviour stays the default) and returns `{ leaveType, balancesUpdated }`; `updateEntitlementForYear` carries `WHERE entitlement <> $3` so that count means *rows that changed*, not rows that matched. Past years are never rewritten; they record what people were entitled to then. A reduction can take a remaining balance negative if someone has already used more than the new figure — reported, not silently prevented, because it is a real consequence of HR's choice.
> - **Deactivating a type blocks new requests, not decisions on existing ones**, so `setLeaveTypeStatus` returns `{ leaveType, pendingRequests }` — otherwise the type disappears from the picker while approvals on it keep landing.
> - **A discontinued type stays visible in `GET /leave-balances/me` to anyone who has days on it** — the read filtered on `lt.is_active = true`, so retiring a type made every past user's own history unreadable while the ledger still held the days. Implemented as `HAVING lt.is_active = true OR SUM(taken_delta) <> 0 OR SUM(pending_delta) <> 0` with `lt.is_active AS leave_type_active` exposed for the client's "Discontinued" badge. **A type the employee never used stays hidden** — a full untouched entitlement reads as leave they could still take.

> ℹ️ **Holidays store a date range, not a single date.** `holidays` has `start_date`/`end_date` (both `NOT NULL`, `end_date >= start_date`), not a single `holiday_date` — this supports multi-day holidays (e.g. a 5-day Diwali). The API accepts `endDate` as optional and defaults it to `startDate` for single-day holidays. There's no DB-level uniqueness on dates anymore (ranges make exact-duplicate uniqueness meaningless); overlap between holidays is instead checked at the service layer (`holidayService.js` → `findOverlappingHoliday`) and rejected with a `409`, same status code as the old DB-constraint-driven duplicate check.

> 🔖 **The runner keeps a ledger, so a run applies only what's new.** `schema_migrations` (filename, checksum, applied_at, duration_ms) is created by `runMigrations.js` itself — it can't be a migration file, since a migration that creates the ledger can't be recorded in the ledger it's creating. Three commands:
>
> | Command | Does |
> |---|---|
> | `npm run migrate` | applies every pending file, in order |
> | `npm run migrate:status` | reports applied/pending/edited/orphaned, changes nothing |
> | `npm run migrate:status -- --verbose` | as above, plus the ledger rows — `baselined` marks a row recorded rather than executed |
> | `npm run migrate:baseline` | records all files as applied **without executing them** — dry run unless given `-- --yes` |
> | `npm run migrate:baseline -- --yes --pending-only` | records only the *unrecorded* files — recovery for a ledger left partial by a failed run |
>
> - **Each file runs in its own transaction, with its ledger row inserted inside it** — so a file either fully applies and is recorded, or neither. A failure stops the run rather than skipping ahead, because migration 040 almost certainly assumes 039 landed. A file needing statements Postgres won't run in a transaction (`CREATE INDEX CONCURRENTLY`) opts out with a `-- migrate:no-transaction` marker.
> - **An edited already-applied file aborts the run before anything is applied.** Fatal on purpose: it means this database and every other one are now running different schemas, and continuing would paper over the divergence.
> - **Checksums hash LF-normalized content, never raw bytes, and that line is load-bearing.** `core.autocrlf=true` is set here, so every `.sql` file is LF in git and CRLF in a Windows working tree — hashing raw bytes would make the identical file hash differently on a laptop than on Render, and *every* run would fail with a meaningless mismatch. There's a test pinning this (`migrations.test.js`).
> - **A session-scoped advisory lock wraps the whole run**, taken on the same client that does the work — `pool.query` could hand each statement a different connection and the lock would then guard nothing. Two concurrent deploys serialize instead of both applying the same pending list.
> - **`baseline` is a one-time step for a database that predates the ledger**, and refuses when the ledger already has rows. That refusal matters: baselining a database that genuinely has migrations outstanding is the single way this system could lose a schema change, and it would do it silently. It is a **dry run by default** — which beats a confirmation prompt because it behaves identically over SSH, in CI, and in a non-interactive shell.
> - **`schema_migrations` must never enter `setup.js`'s `TRUNCATE` list.** Truncating the ledger between tests would make every run believe the database was unmigrated.
>
> 🚨 **Idempotent DDL is not the same as safe to replay against newer data — and this was learned the hard way, in production.** Running `migrate` against the Render database (full schema, no ledger yet) died at `033_alter_notifications_add_types.sql` with `check constraint "notifications_type_check" of relation "notifications" is violated by some row`. 033 narrows that constraint to 16 values; 036 widens it to 17 by adding `PROFILE_CREATED`; the live app had already written rows with that type. Re-imposing 033's narrower version against 036-era rows is a violation, and no amount of `IF EXISTS` guarding prevents it — the file *is* idempotent, and it still can't be replayed.
>
> Two consequences:
> - **For a database that has data but no ledger, `baseline` — not `migrate`.** The earlier advice here (run `migrate`, it "can't lose anything") was wrong: it can't lose data, but it can fail outright, and on a constraint-narrowing file it will. The three-clean-runs verification that produced that advice ran against `_test`, which had no `PROFILE_CREATED` rows, so it proved less than it appeared to.
> - **Nothing broke, because of the per-file transaction.** 033's `DROP CONSTRAINT` rolled back with its failed `ADD`, so the table kept the 036-era constraint. Without the transaction, that table would have been left with no type constraint at all.
>
> Recovery from a half-populated ledger is `migrate:baseline -- --yes --pending-only`, which records the unrecorded files without executing them. It needs both flags on purpose: it is precisely the operation the plain refusal exists to prevent, so it's only ever right when you know the schema is already current — which, in that production case, the failure itself proved (rows of a type only 036 allows).

> **Replay-safety is now a convention, not a requirement.** The ledger means a file runs once, so `IF NOT EXISTS` and friends are no longer what stands between you and a broken run — but keep writing them anyway: they make baselining forgiving and manual recovery possible when a ledger row and reality disagree. What's gone is the *ritual* — you no longer need to run the whole suite twice against `_test` to prove a new file is idempotent. The rules, for reference:
> - `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP ... IF EXISTS`.
> - Seed `INSERT`s carry `ON CONFLICT ... DO NOTHING`.
> - A constraint change is always `DROP CONSTRAINT IF EXISTS` **then** `ADD CONSTRAINT` — `ADD` alone fails on a duplicate name.
> - A `RENAME` can't be made idempotent with a clause, so guard it with a `DO ... information_schema ...` block (see 012).
>
> Historical note, because it explains why all 37 existing files are already idempotent: before the ledger the runner replayed everything on every run, and `002_create_roles.sql`'s bare `CREATE TABLE roles` aborted the whole run with `relation "roles" already exists` — leaving migration 037 unapplied and looking like a problem with 037.

> ⚠️ **Migrations are applied manually to every environment, deliberately — the ledger tells you what's pending, it does not run anything for you.** Adding a migration file still updates no database on its own. After writing one, run `npm run migrate` against the dev DB, the `_test` DB (or backend tests fail on the old schema), **and** the Render production DB. Auto-running on deploy was considered and rejected: a bad migration would then take down production unattended, and Render's free tier gives you no shell to recover from. A deployed frontend hitting an unmigrated production DB shows up as a generic load failure like "Unable to load holidays", easy to misdiagnose as an API/CORS bug — `npm run migrate:status` answers it in one line.

> ⚠️ **FullCalendar `display: "list-item"` does not put a dot on every day of a multi-day event.** A single event with `start`/`end` spanning several days renders as just **one** dot on the start day, so the remaining days look empty. `HolidayCalendar.jsx` therefore expands each holiday range into one single-day event per date (`eachDateKeyInRange` in `client/src/utils/dates.js`) — don't "simplify" it back to one event with an `end`.

---

---

## Authentication & secrets

### 🔐 Authentication

- No public employee registration.
- HR registration uses a **secret registration code**.
- Roles: `EMPLOYEE`, `MANAGER`, `HR_ADMIN`, `SUPER_ADMIN`.
- Passwords must be hashed using **bcrypt**.
- Google OAuth is only an **alternative login method** for existing users (not a signup path) — an email that doesn't match an active account is rejected (`403`), never auto-registered. GitHub OAuth was added and then removed by direct request (only Google is supported); `oauth_accounts.provider` is CHECK-constrained back to `'GOOGLE'` only (migration `019`) — don't reintroduce a second provider without being asked again.

> 🔒 **`verifyAuthToken` pins `algorithms: ["HS256"]` — don't drop it back to `jwt.verify(token, secret)`.** For a
> *string* secret, jsonwebtoken's default allowlist is the whole HMAC family, so a token signed HS384 or HS512 with
> our own secret verified fine: a valid session signed with an algorithm this app never issues. Confirmed by
> experiment, not assumed, and now pinned by a test (`authMe.test.js` rejects an HS512 token carrying the real
> secret). Never reachable without the secret — which is why it was a LOW finding rather than a hole — but the
> allowlist is what makes "we accept exactly what we issue" a fact instead of a coincidence. Pinned on **verify**
> only: `signAuthToken` already emits HS256, and verify is the side where an attacker-supplied header gets a vote.

> 👑 **`SUPER_ADMIN`, a singleton role added to fix a real gap: a manager-less root `HR_ADMIN`'s own leave request could never be approved by anyone** (`resolveActingCapacity` in `leaveRequestService.js` — every non-owner path needs a manager or a subtree relationship, and a root HR_ADMIN has neither), and nobody was positioned to verify their profile either. `POST /auth/register/hr` (`authService.registerHrRoot`) is repurposed to create this one account instead of an unlimited number of root `HR_ADMIN`s — now singleton-guarded (`existsUserWithRole`, throws `409` on a second call) **and, since migration `038`, singleton-*enforced* in the schema — see the bullet below, the app check alone was a check-then-insert**. Migration `034_seed_super_admin_role.sql` adds the role row; **converting an already-existing seeded/bootstrapped HR account to `SUPER_ADMIN` is a one-off manual `UPDATE` the operator runs per environment** (`role_id` + `profile_status = 'VERIFIED'`), not shipped as code — this codebase has no established pattern for data-fixup scripts, and a single, ambiguous production account doesn't justify inventing one.
> - **Reporting**: `reportingService.ALLOWED_MANAGER_ROLES.HR_ADMIN` now includes `SUPER_ADMIN` alongside `HR_ADMIN` — an `HR_ADMIN` can optionally report to the super admin instead of another HR admin. `EMPLOYEE`/`MANAGER` can never report to `SUPER_ADMIN` directly, and `SUPER_ADMIN` itself can never have a manager (absent from the map entirely — `assertManagerAllowed`'s `|| []` fallback already means "no manager ever allowed" for any role with no entry). Three separate places encode reporting-line-eligibility client-side and had to change together: `InviteEmployeeForm.jsx`'s inline filter, `ManagerSelect.jsx`'s hardcoded optgroup role list (a filter fix alone renders nothing without this), and `EmployeePersonRow.jsx`'s own independent copy of the same map used by the "change manager" edit control.
> - **"Same access as HR," with two deliberate exceptions**, both confirmed explicitly rather than assumed:
>   1. **Auto-approve/auto-verify bypasses the review workflow entirely, not a self-approval step.** `SUPER_ADMIN`'s own leave request is inserted directly as `APPROVED` (`decided_by` = itself), never passing through `SUBMITTED` even momentarily — no one to notify, so `notifyLeaveRequestSubmitted` is skipped outright. **The one place this is easy to get subtly wrong**: the ledger write must be a single `{pendingDelta: 0, takenDelta: workingDays, reason: "APPROVE"}` entry, never `ledgerDeltaForAction("APPROVE", ...)` (`leaveRequestService.js`) — that helper assumes an earlier `SUBMIT` entry already moved the days into pending and is releasing that hold; calling it here with no such entry would silently corrupt `days_pending` (goes negative). Every other check (leave type active, working-day count, overlap, balance including `allow_negative_balance`, `requires_document`) still runs unchanged — the bypass is only about *who decides*, never about whether the numbers stay true (NFR-2 doesn't get an exception for this role). Recorded in the audit trail as a new `AUTO_APPROVE` action (`old_status: null`, `audit_logs.action` has no CHECK constraint so this needed no migration). SUPER_ADMIN's profile is simply created `VERIFIED` (`registerHrRoot` calls `updateProfileStatus` right after `insertUser`) — `submitProfileForVerification` is never reached for this account, so no bypass logic lives inside it.
>   2. **No override power, ever — a real, intentional asymmetry with a multi-branch `HR_ADMIN`.** `resolveActingCapacity`'s `HR_OVERRIDE_TO_APPROVED`/`HR_OVERRIDE_TO_REJECTED` branch stays `actor.role === "HR_ADMIN"` only; `SUPER_ADMIN` is never added there, and the client mirrors this (`ApprovalsPage.jsx`'s `canOverride` stays HR_ADMIN-only too). Reasoning: a direct-report `HR_ADMIN`'s own leave is already fully handled by the plain manager-approve path (`isManagerOrDelegateOf` is role-agnostic — once `manager_id` points at SUPER_ADMIN, approve/reject already just works, zero new code needed there), so SUPER_ADMIN never needs override for *that*; and override's real purpose — revisiting an already-decided *employee* request inside a subordinate HR_ADMIN's own branch — is exactly the kind of reach into a subordinate's team the next bullet exists to prevent.
> - **Every other HR-scoped write action is scoped to SUPER_ADMIN's direct-report `HR_ADMIN`s only — never those HR_ADMINs' own downstream teams — via a new `isInActorsHrScope`/`getHrScopedEmployeeIds`/`getHrScopedUsers` trio in `hrScopeService.js`, deliberately not the existing `isUserInSubtree`.** `isUserInSubtree`/`findSubtreeUsers` (`userRepository.js`) are fully generic, transitive `manager_id` walks with zero role awareness — reusing them for SUPER_ADMIN would silently pull in the *entire company*, since every `HR_ADMIN` eventually funnels up to the one SUPER_ADMIN. Confirmed explicitly rather than assumed (a company-wide read stays intentional and unchanged for both roles — only *write* authority is narrower for SUPER_ADMIN): `hrScopeService.js` branches per actor role — `HR_ADMIN` still gets `isUserInSubtree`/`findSubtreeUsers`, `SUPER_ADMIN` gets a plain non-recursive `isDirectReport` check / `findDirectReports`. Touches every subtree-gated write: profile verify/send-back/get-for-verification/pending-verification/verified-list (`userService.js`), document view/review (`employeeDocumentService.js`), salary structure assign (`salaryStructureService.js`), salary slip calculate/confirm/void/list (`salarySlipService.js`), and the "My Team"/FR-024 browse-and-report view (`leaveRequestService.js`'s `listTeamLeaveRequests`/`listFilteredLeaveRequests`/`generateLeaveTakenReport`) — the client's `leaveRequestAuthz.js`'s `canDecideDirectly` mirrors the same narrowing so Approve/Reject buttons never render for something SUPER_ADMIN can't actually act on.
> - **The singleton was only ever enforced in the application, and that wasn't enough — fixed by `038_unique_super_admin_user.sql` (gap G1).** `registerHrRoot` checks `existsUserWithRole` and *then* inserts, with a bcrypt hash in between; two simultaneous `POST /auth/register/hr` calls therefore both pass the check before either commits, and both insert. The remedy is the same one `uq_password_resets_active_user` already established for the identical shape: let the index decide. A partial unique index on `users(role_id)` limited to the `SUPER_ADMIN` role now makes the second insert impossible. **The one thing that isn't obvious**: an index predicate must be immutable, so it cannot contain `role_id = (SELECT id FROM roles WHERE role_name = 'SUPER_ADMIN')` — the role id comes from `gen_random_uuid()` in `034`, so `038` resolves it at migration time inside a `DO` block and interpolates it as a literal, which means **the index definition legitimately differs per database**. `registerHrRoot` also maps `23505` on that specific constraint name back to the same `"A super admin account already exists"` message the sequential path gives, so the race loser doesn't get `errorHandler`'s generic unique-violation wording (which reads as an email clash). The app-level check stays: it answers the ordinary case without reaching the insert. Don't "simplify" either half away — the check alone is not a guarantee, and the index alone gives a misleading message.
> - **A correctly-signed token whose `sub` isn't a UUID answered `500`, not `401` — fixed in `authMiddleware.js` (found while writing gap G2's tests).** `findAuthContextById` passes the subject straight into `WHERE u.id = $1`, so a non-UUID subject reaches Postgres as an invalid uuid literal and raises `22P02`, which `errorHandler` has no branch for. `requireAuth` now shape-checks the subject before the lookup and treats a bad one as unauthenticated. Deliberately **not** fixed by mapping `22P02` in `errorHandler`: that code arriving from anywhere else is a genuine server-side bug and should keep surfacing as a 500. Only reachable by someone holding the real `JWT_SECRET` (a forged signature is rejected earlier), so this was robustness and log hygiene rather than a live hole — but a 500 with a stack trace is itself information, and the test that found it now pins the behaviour.

> - **Two chain-walk functions filtered by the literal string `"HR_ADMIN"` needed broadening, or they'd silently swallow a real case**: `notificationService.js`'s `resolveNearestHrAncestor` (an HR_ADMIN reporting straight to SUPER_ADMIN who submits their own profile would otherwise notify nobody — chain is `[SUPER_ADMIN]`, role never matches) and `userService.js`'s `attachReportingLine` (same HR_ADMIN would see `hr: null` on their own profile page instead of SUPER_ADMIN). Both now also match `"SUPER_ADMIN"`.

---

### 🤫 Secrets

- `server/.env` holds `DB_PASSWORD`, `HR_REGISTRATION_CODE`, `SMTP_PASS`, and other credentials.
- Never commit real `.env` values.
- Never log secrets, credentials, or password values (plain or hashed) to console or error responses. This includes **raw reset/invite tokens and the links containing them** — `passwordResetService.js` deliberately keeps the link out of its mail-failure log for exactly this reason.

> 🚨 **The same leak, but with `DATABASE_URL`, could have truncated production — and the existing guard did not catch
> it.** `config/db.js` prefers `DATABASE_URL` over the discrete `DB_*` vars **whenever it is set**, while
> `setup.js`'s guard only ever checked `DB_NAME`. `.env.test` sets `DB_NAME` to a `_test` value, so with a
> `DATABASE_URL` left in the shell — exactly what you set to run a migration against Render — the guard passed on one
> variable while the pool connected using another, and `setup.js`'s `beforeEach` then ran
> `TRUNCATE users, invitations, … CASCADE` against **production**, reporting a healthy green run while doing it.
> Nothing was lost; the window was found and closed before anyone ran the suite in such a terminal.
> - **The rule is now enforced in code, not by memory:** `helpers/testDatabaseGuard.js`'s `assertTestDatabase` refuses
>   unless `NODE_ENV` is `test`, `DB_NAME` ends in `_test`, **and** any `DATABASE_URL` present also names a `_test`
>   database. An unparseable URL is refused too — "can't tell" must fail closed. Ten unit tests cover it, including
>   that the error names the database but never the connection string, which holds a password.
> - **It is extracted from `setup.js` on purpose.** Inline, the rule could only be exercised by spawning an entire
>   vitest run, so in practice it was never tested — which is precisely how it carried a hole this size.
> - **`assertTestDatabase` must stay above the `config/db.js` import in `setup.js`.** Importing that module builds the
>   pool; the check is worthless after it.
> - **Belt and braces, same as SMTP:** `.env.test` also blanks `DATABASE_URL=`, which neutralises a shell value via
>   `override: true` before the guard even looks. That half protects this machine only — `.env.test` is gitignored, so
>   the committed guard is the half that protects a fresh clone.
> - **Operationally:** prefer setting `DATABASE_URL` for a single command over exporting it into a shell you keep
>   using. While it is set, every `npm run migrate` *and* every `npm test` in that terminal is aimed at production.

> ⚠️ **`server/.env` leaks into the test process, so blank every new secret in `.env.test`.** `tests/integration/setup.js` loads `.env.test` with `override: true`, but `config/cloudinary.js` and `config/mailer.js` each call `dotenv.config()` on import (non-override) — so any key present in `.env` and **absent** from `.env.test` still lands in `process.env` during a test run. When SMTP credentials were added this became a live hazard: without blank `SMTP_HOST=`/`SMTP_USER=`/`SMTP_PASS=` entries in `.env.test`, any test touching a mail path without stubbing the service would send **real email**. Belt and braces: those blank entries exist, *and* `config/mailer.js`'s `sendMail` hard-returns when `NODE_ENV === "test"`.

---

---

## API response format & testing

### 📡 API Response Format

**Success:**
```json
{ "success": true, "message": "...", "data": {} }
```

**Error:**
```json
{ "success": false, "message": "...", "errors": {} }
```

> ⚠️ **Known gap:** existing `userController.js` returns plain `res.json(users)` without this envelope.
> New/changed endpoints must use the envelope; old endpoints should be migrated to it when touched.

---

### 🧪 Testing

- Every module requires backend **integration tests**.
- Frontend components require **component tests**.
- Test every API before moving on to the next feature.

> 🏁 **One command runs everything: `npm test` at the repository root.** The root `package.json` is a task runner and
> nothing else — no dependencies of its own, `npm install` still belongs in `server/` and `client/`. It exists because
> deliverable #3 requires the suite to run from a single documented command, and because composing two `npm --prefix`
> invocations by hand is how you end up running only half of it. `test:server` / `test:client` run either half.
> The `&&` between them is load-bearing: the two suites compete for one machine, and running them concurrently has
> produced timeouts that look exactly like real failures (see the ⏱️ note below), so sequencing them structurally
> beats remembering not to.

> 🔑 **bcrypt runs at cost 4 under `NODE_ENV=test`, 10 everywhere else (`utils/password.js`) — the server suite went
> from 665s to 281s, measured before and after on the same machine.** Measured on this codebase: the integration suite makes ~914 hash
> and compare calls (559 user creations, 355 logins) at ~189ms each — about 173 seconds of a 665-second run — spent on
> a cost factor whose only purpose is to be slow for an attacker. At cost 4 the same calls take ~3.6ms. Safe because
> bcrypt embeds the cost in the hash, so `verifyPassword` validates any cost without being told which, and nothing
> asserts the cost factor or the hash's shape.
> - **Don't raise it "for realism" and don't lower production to match.** The production value is the security control;
>   the test value exists because the suite has no adversary.
> - **Attribute the win honestly:** the predicted bcrypt saving was ~173s and the observed total was ~384s. Import
>   time also halved (113s → 62s), which bcrypt cannot explain, so some of that gap is a warmer filesystem cache and a
>   quieter machine. The bcrypt share is the part that's measured directly.
> - **The general lesson worth reusing:** before optimising a slow suite, measure where the time actually goes. The
>   obvious suspects here were Postgres and the twelve-table `TRUNCATE`; the actual answer was a deliberately slow
>   hash function called a thousand times. **And now that it's gone, `TRUNCATE` really is the top cost** — measured at
>   ~840ms (max 986ms) per call, once per test, so ~280s across 333 tests. That's what P3 (one test database per
>   vitest worker) and cheaper Postgres durability settings on the test cluster (`fsync=off`,
>   `synchronous_commit=off`) would attack next.

> ⏱️ **The `testTimeout`/`hookTimeout` values in both vitest configs are deliberate — don't delete them as noise, and don't raise them to hide a hang.** Vitest defaults to 5s per test and 10s per hook, which suits unit tests and sits *below* this project's normal operating range: server files are integration-level against a real Postgres and honestly take 10–20s each, `setup.js`'s `beforeEach` truncates twelve tables with `CASCADE`, and one client `userEvent.type` of a sentence is dozens of sequential React renders in jsdom. Under contention the defaults expire on work that is progressing perfectly well, which reads as a real failure and sends the next person hunting a bug that doesn't exist — that is exactly how they were found. Now 30s/30s (server) and 15s (client).
> - **The cost is accepted, not overlooked:** a genuinely hung test takes 30s to report instead of 5s. If a test starts *needing* the extra headroom, that's a signal about the test, not a reason to raise the ceiling again.
> - **Verify a timeout change with a throwaway probe that exceeds the old value, then delete it.** A config value that parses tells you nothing about whether it applies; a 12s hook and a 7s test do.
> - **Never run the server and client suites concurrently on one machine.** That is what produced the two red tests above, and both passed in isolation. Run them one after the other — `npm test` at the root already sequences them with `&&`.
> - **⚠️ Raising `testTimeout` does nothing for `findBy*` / `waitFor`, and that caught us out.** Testing Library keeps
>   its own budget, `asyncUtilTimeout`, defaulting to **1000ms** — so a `findByRole` waiting on a mocked fetch fails at
>   one second no matter what vitest is configured to allow. There are **266 `findBy*` calls** in the client suite, most
>   of them waiting on exactly that, which makes it the largest single source of load-sensitive flake here:
>   `DelegationForm`'s "excludes the current user" test failed at 1638ms waiting for a `<select>` to fill, with nothing
>   wrong with the component or the test. Now `configure({ asyncUtilTimeout: 5000 })` in `client/src/tests/setup.js`.
>   Kept well below the 15s `testTimeout` on purpose: an element that genuinely never appears then still fails with
>   Testing Library's "unable to find role=…" plus a DOM dump, rather than a bare vitest timeout that explains nothing.
> - **The client suite runs on `pool: "threads"`, not vitest's default forks.** Forking one node process per file — 63
>   of them, each loading Vite's module graph and booting jsdom — failed outright on this machine when the client
>   suite started straight after the server suite: six `Failed to start forks worker` errors, so **six files never ran
>   while the run still looked broadly green.** A suite that silently skips files is worse than a slow one. Threads
>   share the process, so startup survives a machine that's still busy.

> 📅 **A fixture dated relative to the real "today" is a fixture that fails on some day of the week — use
> `tests/integration/helpers/dates.js`, never raw date arithmetic.** Found the hard way: two `dashboardCounts.test.js`
> tests submitted a single-day leave request dated exactly `today`, which is zero working days on a Saturday or Sunday,
> so `submitLeaveRequest` refused it and the test died *in setup* with an error that looks nothing like the thing it
> tests. A third fixture in the same file (`today+10 … today+11`) had the same bug latently — two consecutive days land
> on Sat+Sun whenever today is a **Wednesday**.
>
> - **Default to the fixed future dates in `factories.js`** (2027). Only reach for "today" when today is genuinely part
>   of the behaviour under test — in practice that's `GET /leave-requests/on-leave-today` and the delegation sweep.
> - **The arithmetic that traps people is window width.** Any *three* consecutive days contain a working day, so
>   `today−1 … today+1` is safe. Anything narrower has some weekday it breaks on, and "it passed when I wrote it" only
>   tells you about one day in seven.
> - `leaveRangeCoveringToday()` for "leave that overlaps today" — stays exactly `today → today` on a working day, and
>   stretches by one day onto the adjacent weekday otherwise, so the tight case is preserved where it's available.
>   `leaveRangeAfterToday(n)` for "leave comfortably in the future" — shifts onto the next working day.
> - **Verify a fix like this across all seven days, not just the day you found it on.** Freezing the clock in a
>   throwaway script is enough; the point is that the day you happened to be working on proves the least.
> - Delegations have no working-day rule, so `notifications.test.js`'s `today`-relative delegation fixtures are fine
>   as-is — the trap is specific to anything that goes through `submitLeaveRequest`.

---
