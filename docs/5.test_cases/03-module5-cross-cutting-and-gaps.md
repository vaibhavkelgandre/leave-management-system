# Module 5, cross-cutting coverage & known gaps

> Part of [Test Cases](README.md). If this disagrees with the code, the code wins.

---

## Module 5 — payroll & employee profile

### Module 5: Payroll & Employee Profile

#### ✅ Covered

**Server — `profileVerification.test.js`**
- Rejects submission with missing fields (400) or missing required documents (400)
- Full state machine: `INCOMPLETE → SUBMITTED → VERIFIED`, visible in HR's pending queue only while `SUBMITTED`
- Send-back to `INCOMPLETE` with a required reason (422 if missing), reason visible to the employee, cleared on resubmission
- Rejects verify/send-back from non-HR (403) or an out-of-subtree HR admin (404)
- Rejects verifying a still-`INCOMPLETE` profile (409)
- Detail fetch scoped to the caller's subtree; verified-employee listing scoped the same way

**Server — `profileVerification.test.js`** (document-gate cases)
- Refuses to verify a profile while any required document is still `PENDING_REVIEW` (400, names the missed document, profile stays in the queue)
- Refuses to verify a profile with a `REJECTED` document, and the message points HR at sending it back rather than retrying
- Blocks resubmission until a rejected document is actually replaced, then accepts it and lets HR verify once the replacement is reviewed

**Server — `employeeDocuments.test.js`**
- 401 unauthenticated; rejects non-PDF/JPG/PNG content regardless of declared type (400)
- Upload replaces a prior upload of the same required type; visibility scoped to uploader + in-subtree HR (404 otherwise)
- HR review (verify/reject with comment), rejected from non-HR (403)
- Custom documents: add any number, requires a name (422), fetch/delete own only (404 for someone else's)

**Server — `employeeDocuments.test.js`** (document streaming)
- Streams a document `inline` by default — correct `Content-Type`, `Content-Disposition: inline`, original filename, real bytes — which is what makes a PDF previewable at all (Cloudinary raw delivery forces a download)
- `?disposition=attachment` still forces a save; the `/url` payload carries the `documentId` the viewer needs
- 404 for a peer employee, 401 unauthenticated, 422 for a malformed id or a `disposition` outside the two allowed values

**Server — `salaryStructures.test.js`**
- 401 unauthenticated; rejects non-HR (403)
- Assign within subtree, visible to employee + HR; update archives prior figures as a revision
- Out-of-subtree employee unreachable (404)

**Server — `salarySlips.test.js`**
- 401 on every route; rejects calculate/confirm from non-HR (403)
- Skips (without failing the run) unverified/no-structure employees, and one not yet joined for the period, with per-row reasons
- Correct net-pay calculation with zero LOP; correct LOP deduction and per-day rate rounding for a `counts_as_lop` type
- Pro-rates earnings for an employee who joined partway through the period (divisor stays the full month, payable days shrink), with a strictly lower net pay than the full-month figure
- Reports `total_leave_days` as a superset of the LOP-only `lop_days` figure when both a LOP and a non-LOP leave type were taken in the same period
- Rejects re-confirming an already-`ACTIVE` period (skip, figures untouched); allows confirming again after voiding, archiving pre-void figures
- `calculate` still previews full figures even when `confirm` would be blocked
- Rejects calculate/confirm for a not-yet-started period (400) **and** for the current, still-running month (400) — only a fully completed past month is runnable
- Subtree-scoped visibility/generation throughout, including `/mine` vs. team list separation and role/profile-status filters
- Void with reason; rejects double-void (409); rejects from non-HR (403) or out-of-subtree HR (404)
- Re-confirm after void supersedes back to `ACTIVE`
- Visible only to the employee and HR (404 for the manager); PDF disposition defaults to `attachment`, `inline` opt-in, any other value falls back safely (no header injection)

**Server — `salarySlips.test.js`** (guard cases)
- Skips an employee whose net pay works out to zero, keeping the figures visible, and commits nothing for them
- Reports an employee who already holds an `ACTIVE` slip for the period as `already_generated` **in the preview** (not just at confirm), with `computed: null` and a matching `summary.alreadyGenerated`; a second approve commits nothing and leaves the original slip untouched
- Returns that employee to `ok` once their slip is voided, reopening the period for a corrected run
- *(Replaced the earlier "still previews full figures for a period that already has an ACTIVE slip" case, which asserted the pre-fix behaviour.)*

**Server — `payslipEmail.test.js`** (`mailService` mocked; the PDF renderer deliberately is **not**, since the point is that a real attachment reaches the sender)
- Emails each employee their own payslip after a confirmed run: right recipient, human-readable period label, `payslip-YYYY-MM.pdf` filename, and a real PDF buffer (asserted on the `%PDF-` signature)
- One email per committed slip and none for a skipped employee
- One employee's failed send doesn't stop the others, and never touches the committed slips
- A run that commits nothing emails nothing

**Server — `numberToWords.test.js`, `payslipPdfService.test.js` (unit)**
- Correct Indian-numbering-system conversion across zero/tens/hundreds/thousands/lakhs/crores, paise rounding, numeric-string input
- Produces a structurally valid, non-empty PDF for a complete slip, with missing optional fields, with an LOP deduction present, and for an employee who joined partway through the period (fewer payable days than the month)

**Client — `ProfilePage.test.jsx`, `ProfileForm.test.jsx`, `ProfileDocumentUpload.test.jsx`, `ChangePasswordForm.test.jsx`, `ChangePasswordModal.test.jsx`, `EmployeeDetailsPage.test.jsx`, `EmployeeVerificationPage.test.jsx`, `EmployeeVerificationDetailPage.test.jsx`, `SalaryStructureForm.test.jsx`, `PayrollRunPage.test.jsx`, `PayrollRunForm.test.jsx`, `SalarySlipsPage.test.jsx`, `SalarySlipList.test.jsx`, `DocumentViewerPage.test.jsx`, `DocumentPreviewModal.test.jsx`**
- Full profile page: identity display, manager/HR display, send-back banner (and its disappearance once verified), read-only↔edit toggle, submit-for-verification wiring
- Profile form: collapsible sections, prefill, partial-save, conditional fields (no-passport / no-health-insurance clearing), server validation surfacing
- Document upload widget: required-slot states, rejection-with-comment + replace flow, custom document add/remove
- Password change form + modal wrapper
- Employee details (post-verification, read-only) and verification queue/detail pages: full profile display, document view/verify/reject, whole-profile verify/send-back with required reason and cancel-out
- Salary structure form: assign vs. update labeling, prefill, submit
- Payroll run: calculate preview with role/status filters, approve with committed/skipped-with-reason summary, error surfacing
- Salary slips page: employee-vs-HR views, tabs, void action, pay-period/role/employee filters
- Document viewer/preview: own vs. others'-via-HR vs. custom vs. salary-slip URL resolution, unsupported-type fallback, error handling, "open in new tab"
- Dashboard tile: never fetches a request list or the full team roster (regression test for the count endpoints), and titles itself for the organisation vs. the team by role
- NavBar badge: renders the server's count, asks for no count at all for an employee with no delegation
- Approvals: pages the list while the calendar keeps its whole month (the windowed call sends no `limit`), and hides the pager when everything fits on one page
- Salary Slips: pages the team list, resets to page 1 when a filter changes, hides the pager on a single page
- HR Reports browse: pages through results showing the server's total, hides the pager when everything fits on one page, and returns to page 1 when filters are applied or cleared
- Dashboard "on leave today": renders as a table with Employee/Role/Leave type/Dates/Days columns, sorted by name, half-day noted; `SUPER_ADMIN` reads the company-wide list (and the tile is titled "Organisation overview") while every other role reads the team-scoped one
- Dashboard "My leave": the leave-type picker filters the history to that type and shows its balance detail, a balance chip selects its own type, an untouched type says so, and each type keeps its own accent colour
- My Team: HR can change a report's manager and deactivate them; a plain `MANAGER` is offered neither control on any row, including one attributed to them (the routes are HR-tier server-side); the manager-edit form opens in its own full-width `colSpan` row (not inside a column), the extended team is grouped under each manager with no Reports To column, and an unresolvable-manager report still shows (with that column back on)
- `groupTeamByManager` (unit): groups reports under managers resolved from the directory, sorts managers and reports by first name, and collects anyone whose manager can't be resolved instead of dropping them
- TopBar: the bar shows initials + role badge but not the user's name (which is the trigger's accessible name and appears in the open menu), carries no brand label, logs out only from inside the account menu, and the search box grows on focus / shrinks on blur while staying expanded whenever a query is present
- Calendar events: hovering a holiday (HolidayCalendar) or a team leave bar (ApprovalsPage) shows the app's own `role="tooltip"` label with the date range and status, removes it on unhover, and carries no native `title` attribute
- Document viewer renders every employee document through the app's own stream (`/employees/documents/:id/file`), never the Cloudinary URL — including the "open in new tab" link — with a fallback to the given URL when there's no document id (the salary-slip path)
- Payroll run badges an already-paid employee as "Already received", distinctly from an amber "Skipped", and says how many in the summary line

#### 🔴🟡 Gaps

These first three are **already-documented, deliberate product gaps** from `.claude/rules.md`, not just missing tests — surfacing them here so they're visible in one place with everything else:

- 🟨 **Partially covered (was 🔴): a salary slip's LOP drifting from the leave record after the slip was issued.** Analysed as six scenarios — late approval, backdated submission, HR override in either direction, a second approval after the run, and flipping a leave type's `counts_as_lop` — of which **five overpay**, and an overpayment is the one nobody ever queries. Closed by prevention rather than re-sync, because a payslip *should* be a snapshot: rewriting one an employee has already received as a PDF would destroy the record of what was actually paid.
  - **`assertPeriodsOpen` (M1)** refuses a decision with `409` when the request overlaps any period where that employee already holds an `ACTIVE` payslip, naming the period and the way out (HR voids it, which reopens that employee's period). Per-employee and derived from their own slip — no `payroll_periods` table, no close/reopen action. Locks the four LOP-affecting actions only; `WITHDRAW` stays open on purpose, since a `SUBMITTED` request never counted toward LOP and withdrawal is the employee's remaining exit.
  - **`sweepOverdueLeaveRequests` (M5)** reports requests still `SUBMITTED` 30+ days after their start date, to the manager (who can decide) and the employee (who can withdraw). It exists because `SUBMIT` holds days in `pending` and only a decision or a withdrawal releases them, so an undecided request shrinks a balance permanently — true before the lock, more reachable after it. It **notifies rather than auto-closes**: every auto-close needs an actor recorded against the decision, and writing down a manager who never looked at it puts a false action in an append-only audit trail.
  - **Still open, and the reason this is 🟨 not ✅:** flipping `counts_as_lop` on a leave type (scenario E) changes historical LOP for every employee with **no leave decision involved**, so no decision-blocking rule of any shape can see it. Catching it needs the reconciliation check that was designed alongside these two — compare each `ACTIVE` slip's stored `lop_days` against a live `findLopWorkingDays` and flag the difference — which is **not built**. Also still open: whether an `EXPIRED` status should replace M5's advisory notification, which is a product decision about what the employee sees rather than a technical one.

**Server — `payrollLock.test.js`** (8 tests)
- Refuses an approve, and an HR override, for a period that already has an issued payslip — `409`, naming the period and the void
- Allows the approval once the payslip is voided, which pins the correction path rather than just the block
- Still allows the employee to **withdraw** a locked request, since that cannot invalidate a slip
- Locks a request spanning two months when **either** month has a slip (a request is charged in full to every period it overlaps)
- Doesn't lock a different period, and doesn't lock across employees — a colleague's payslip is irrelevant
- Reports the authorization failure (`404`), not the lock, for a manager outside the team — someone with no business seeing the request learns nothing about its payroll

**Server — `overdueLeaveSweep.test.js`** (7 tests)
- Notifies both the manager and the employee, with different wording and (per the two notification types) different click destinations
- **Leaves the request untouched** — status stays `SUBMITTED`, `decided_by` stays null, and the audit trail still shows only `SUBMIT`
- Ignores recent requests and already-decided ones
- Doesn't notify twice in a day however often the sweep runs — it fires hourly and again on every restart
- Still notifies when the employee reports straight to HR with no separate manager
- Withdrawing after the nudge returns the pending days to the balance, which is the point of the nudge
- 🔴 **No proration for an employee who *exits* mid-pay-period** — full-period figures are always calculated regardless of actual days employed. (Proration for an employee who *joins* mid-period was the other half of this gap — that half is now implemented, see `salarySlips.test.js` above and `.claude/rules.md`'s payroll section.)
- 🟡 **Regenerating a slip after voiding always uses today's salary structure**, not the structure as of the original period.

Genuinely untested (not just declined):

- 🔴 **No test that the generated PDF's printed figures actually match the input data.** `payslipPdfService.test.js` only checks the byte stream is a structurally valid, non-empty PDF — never that the net-pay number rendered in it matches what was passed in. A positioning/formatting bug could silently print the wrong number while still "producing a valid PDF."
- 🟡 No test at the file-size **limit boundary** for document/leave-request uploads (only wrong-content-type is tested, not exactly-at-the-limit vs. one-byte-over).
- 🟡 No test simulating a Cloudinary upload failure — the documented guarantee ("a Cloudinary failure never leaves a half-created request behind") has no test exercising the failure path itself.
- 🟡 No validation-edge-case tests for salary structure figures (negative pay, HRA exceeding basic, non-numeric input).
- 🟡 No `SUPER_ADMIN`-specific test against salary structures/slips/documents directly — `superAdmin.test.js` proves the direct-report-only scoping principle via profile verification only; the same principle is applied to three other services per `.claude/rules.md` but isn't independently exercised there.

---

---

## Cross-cutting — notifications, SUPER_ADMIN, shared UI

### Cross-Cutting: Notifications

#### ✅ Covered

**Server — `notifications.test.js`**
- 401 on every route; scoped strictly to the caller's own notifications (404 marking someone else's read)
- Unread count tracking, `/read-all`, idempotent re-marking
- Correct recipient + wording for: leave submission (manager, or HR when no manager), decision (including "(HR override)" suffix), withdraw/cancel, profile submit/verify/send-back round trip, salary slip confirmed/voided, manager reassignment (both parties, correct wording each, no-op suppressed), account activate/deactivate, salary structure update (**confirmed to never leak figures**), delegation nomination, team-member assignment + invite-accepted + the new employee's own profile-created prompt (all three from one invite/accept round trip), and the scheduled delegation start/end sweep (with dedup against repeat sweeps)

**Client — `NotificationBell.test.jsx`, `NotificationsPage.test.jsx`, `notificationRouting.test.js`**
- Badge count (including 9+ cap), empty state, click-to-navigate + mark-read, "mark all read" gating
- Full notifications page pagination (20/page, Previous/Next boundary states)
- Every notification type's deep-link destination mapped and tested, including the types with no dedicated page (fallback destinations)

#### 🔴🟡 Gaps

- 🟡 **No test that a failing `notify*` call doesn't break its parent action.** This is a stated architectural guarantee (try/catch, never rethrown) but nothing deliberately breaks a notify call and asserts the triggering action still succeeds — cheap to add, protects a real guarantee.
- 🟡 No test of the bell's 30-second polling actually re-fetching over time (likely mocked around in existing tests).

---

### Cross-Cutting: SUPER_ADMIN

#### ✅ Covered

**Server — `superAdmin.test.js`**
- Own leave request auto-approves (never `SUBMITTED`), correct ledger state (taken, not pending), single `AUTO_APPROVE` audit entry
- A direct-report `HR_ADMIN`'s own request goes through normal `SUBMITTED`→approved-by-SUPER_ADMIN-as-manager
- No override power under any circumstance (403)
- Scoped to direct-report `HR_ADMIN`s only — can verify a direct report's profile, cannot reach two levels down (404)
- Notified when a direct report submits their profile
- `HR_ADMIN` reporting to `SUPER_ADMIN` shows correctly in the company-wide user list

#### 🔴🟡 Gaps

- 🟡 **The direct-report-only scoping principle is only independently tested via profile verification.** The same `isInActorsHrScope` helper is applied to salary structures, salary slips, and employee documents per `.claude/rules.md`, but none of those three has its own `SUPER_ADMIN`-scoped test proving the two-levels-down block holds there too.
- 🟡 (Manual, not automatable) No documented manual test of promoting an **existing** `HR_ADMIN` to `SUPER_ADMIN` via the one-off `UPDATE` statement — worth a one-time manual pass confirming a promoted account behaves identically to a freshly-bootstrapped one.

---

### Cross-Cutting: Shared UI / Layout

#### ✅ Covered

**Client — `NavBar.test.jsx`, `Sidebar.test.jsx`, `TopBar.test.jsx`, `Tooltip.test.jsx`, `SearchSelect.test.jsx`, `Avatar.test.jsx`, `ProgressBar.test.jsx`**
- Role-based link visibility, delegate-driven reveal of Approvals, pending-approvals badge accuracy
- Collapsed-only hover tooltip behavior, portal-mode rendering/positioning/cleanup, `document.body` attachment
- Sidebar collapse/mobile-close callbacks, logo centering
- Top bar search filtering, identity dropdown, logout
- Searchable select combobox: filtering, keyboard interaction (Enter/Escape), click-outside revert
- Avatar initials, progress bar clamping

#### 🔴🟡 Gaps

- 🟡 No automated accessibility (a11y) audit anywhere (no `axe-core`/`jest-axe`) — manual a11y fixes exist (collapsed-nav `aria-label`, `sr-only` toggle labels) but nothing guards against future regressions.
- 🟡 No test that the sidebar's collapsed/expanded preference actually **persists via `localStorage`** across a reload (only the toggle callback firing is tested).
- 🟡 No automated responsive/viewport test for NFR-8 (phone-width usability) — verified manually per `4.non_functional_requirements.md`.

---

---

## Non-functional gaps & suggested testing order

### Non-Functional & Infrastructure Gaps

These don't belong to a single module — they're about the *kind* of testing this app has zero coverage of, regardless of feature.

- 🔴 **No end-to-end (E2E) browser test suite at all.** Every existing test is either a backend integration test (Supertest, no real browser) or a component test with mocked services (no real backend/DB). Nothing drives the actual full stack — real browser, real API, real database — through a complete journey (e.g., HR invites → employee accepts → submits leave with a document → manager approves → balance updates → HR runs payroll → employee views their payslip). This is the single biggest structural gap, and directly relevant to what "end-to-end module testing" means for this app today.
- 🔴 **No load/performance testing** against the explicit NFR-7 target (200 employees, 3 years of history) — confirmed "not measured" in `4.non_functional_requirements.md` itself. Several list endpoints are also unpaginated.
- 🔴 **No adversarial security test pass** — SQL injection attempts (architecturally prevented via parameterized queries, but never tested against), XSS payloads in free-text fields (reason, comments, custom document names) rendered back into the UI, and CSRF exposure given the cross-site `SameSite=None; Secure` cookie setup used for the Render deployment.
- 🟡 No CI pipeline evidence (no GitHub Actions or similar) enforcing that the test suite actually runs on every push/PR — tests exist and pass locally, but nothing stops a broken build from being pushed.
- ✅ **Covered: the integration suite can no longer be pointed at a non-test database.** Found while applying migration 038 to production, not by a failing test: `config/db.js` prefers `DATABASE_URL` over the discrete `DB_*` vars whenever it is set, but `setup.js`'s guard only checked `DB_NAME` — which `.env.test` always sets to a `_test` value. So a `DATABASE_URL` left in a shell (exactly what you set to migrate Render) satisfied the guard while pointing the pool at production, where `beforeEach`'s `TRUNCATE … CASCADE` across twelve tables would have run and reported a green suite. Nothing was lost. Now `helpers/testDatabaseGuard.js`'s `assertTestDatabase` requires `NODE_ENV=test`, a `_test` `DB_NAME`, **and** a `_test` database in any `DATABASE_URL`, failing closed on a URL it can't parse — with ten unit tests, including one asserting the error names the database but never the credential-bearing URL. Extracted from `setup.js` deliberately: inline, the only way to exercise it was to spawn a whole vitest run, which is why it went untested and carried a hole this size. `.env.test` also blanks `DATABASE_URL` as a second layer, but that file is gitignored, so the guard is the part that protects a fresh clone.
- ✅ **Covered: the client suite runs on worker threads rather than child-process forks, which is what made the single command trustworthy.** The chained `npm test` failed on both of its first two attempts for purely environmental reasons — once with six `Failed to start forks worker` errors (six files never ran, while the run still looked broadly green, which is the worst failure mode available), once with a truncate hook stalling past 30s. Each half passed reliably alone, so the trigger was the second suite starting the instant the first ended: 63 forked node processes, each loading Vite's module graph and booting jsdom, on a machine still busy from 33 files of Postgres work. `pool: "threads"` shares the process, so worker startup is cheap enough to survive that. Worth stating plainly: a command whose red is usually noise trains everyone to ignore red, so this was a prerequisite for the command being worth having at all — not a cosmetic fix.
- ✅ **Covered: the suite now runs from one documented command, `npm test` at the repository root** — deliverable #3 asks for exactly that, and until now there was no root `package.json` at all and no test command in the README, so running "the tests" meant knowing to invoke two separate ones. The root package is a task runner only (no dependencies; `npm install` still belongs in each half), with `test:server`/`test:client` for either side. Sequenced with `&&` on purpose — the two suites compete for one machine, and running them concurrently produced the timeouts described below.
- ✅ **Covered: the server suite went from 665s to 281s, measured before and after on the same machine.** bcrypt now runs at cost 4 under `NODE_ENV=test` and 10 everywhere else. The suite makes ~914 hash/compare calls (559 user creations, 355 logins) at ~189ms each — ~173s of a 665s run — on a cost factor that exists solely to be slow for an attacker; at cost 4 they cost ~3.6ms. Safe because bcrypt embeds the cost in the hash, so verification is unaffected, and nothing asserts hash shape. Worth recording as a method as much as a fix: the suspected culprits were Postgres and the twelve-table `TRUNCATE`, and the real one was a hash function.
- ✅ **Partial: test timeouts are now chosen rather than inherited, which is a prerequisite for the CI gap above.** Both suites ran on vitest's defaults — 5s per test, 10s per hook — which are calibrated for pure unit tests. This project's server suite is integration-level against a real Postgres (a single test routinely does a bcrypt hash plus several HTTP round trips, and `setup.js`'s `beforeEach` truncates twelve tables with `CASCADE`), so its files legitimately take 10–20s each; on the client, one `userEvent.type` of a realistic sentence is dozens of sequential React renders in jsdom. The defaults sat *below* the normal operating range rather than above it. Found by running both suites concurrently on one machine: two unrelated tests failed — a client test at the 5s ceiling and, on the server, the shared `beforeEach` hook at the 10s one (charged to whichever test came next, so the reported name was arbitrary). Both passed in isolation, and the server suite came back 333/333 alone, so neither was a defect. Now explicit: `testTimeout`/`hookTimeout` 30s in `server/vitest.config.js`, `testTimeout` 15s in `client/vite.config.js`, each with a comment saying why. Verified with throwaway probe tests that deliberately exceeded the old defaults (a 12s hook and a 7s test) and were deleted straight after — asserting a config value parses proves nothing about whether it applies.
  **A second layer of this, found while verifying the first:** raising vitest's `testTimeout` does nothing for Testing Library's `findBy*`/`waitFor`, which keep their own `asyncUtilTimeout` — 1000ms by default. With 266 `findBy*` calls in the client suite, nearly all waiting on a mocked fetch plus a re-render, that was the largest remaining source of load-sensitive flake, and it took down `DelegationForm`'s "excludes the current user" test at 1638ms with nothing wrong in the component or the test. Now 5000ms in `client/src/tests/setup.js`, deliberately below the 15s `testTimeout` so a genuinely-missing element still fails with Testing Library's DOM dump rather than a bare vitest timeout.
  **Result:** `npm test` completed green end to end — server 334/334, client 433/433, no worker errors — after failing on each of its first two attempts. Roughly six minutes total.
  **Why partial, not covered:** the trade is real — a genuinely hung test now takes 30s to report instead of 5s — and the underlying constraint isn't fixed, only accommodated. A 500s+ serial server suite on one machine stays fragile until CI runs it on a dedicated runner, and a shared runner is *more* contended than a laptop, not less. Revisit these numbers when the CI gap above is closed; that's the environment they exist for.
- ✅ **Covered (was 🔴): date-dependent fixtures in `dashboardCounts.test.js` no longer depend on what day it is.** Found on Sat 2026-08-22 while closing the Module 1 gaps, and confirmed pre-existing by re-running against unmodified code. Two tests submitted a single-day leave request dated exactly `today`, which on a Saturday or Sunday is zero working days — so `submitLeaveRequest` correctly refused it and the test errored *during setup*, before reaching any assertion. Checking the rest of the file turned up a third, latent instance of the same class: a `today+10 … today+11` fixture lands on Sat+Sun whenever today is a **Wednesday**, so it would have failed every Wednesday without anyone connecting it to this. All three now go through `helpers/dates.js` — `leaveRangeCoveringToday()` keeps the tight `today → today` range on a working day and stretches by exactly one day onto the adjacent weekday otherwise (Friday on a Saturday, Monday on a Sunday), while `leaveRangeAfterToday(n)` shifts a future fixture forward to the next working day. Verified against all seven days of the week by faking the clock, not just the day it was fixed on. The `today−1 … today+1` ranges were left as they are and carry a comment saying why: three consecutive days always contain a working day, so only windows narrower than that need a helper.
**Server — `migrations.test.js`** (the migration ledger)
- Applies pending files in filename order, records each, and applies nothing on a second run
- Applies only the new file when one is added after an earlier run
- A failed migration rolls back, records nothing, and stops later files from running
- An edited already-applied file aborts the run before anything is applied
- Checksums ignore line endings, so the same file matches on Windows and Linux
- `baseline` is a dry run by default, records without executing when applied, and refuses once the ledger has rows
- `baseline --pending-only` records just the unrecorded files without executing them, is still a dry run without `--yes`, and reports when there's nothing left to record
- `inspect` separates pending / edited / orphaned without changing anything
- The real `src/sql` directory has unique, zero-padded, three-digit prefixes

---

### Suggested Testing Order

Given the volume above, a practical module-by-module order — most reviewed/highest-risk first, matching what `.claude/rules.md` itself says reviewers will probe hardest:

1. **Module 3 (Leave Requests & Approval)** — already the best-covered; close the two 🔴 gaps (long-sequence balance drift, concurrent overlap race) since this is explicitly the top review criterion.
2. **Module 5 (Payroll)** — highest financial/data-integrity stakes; start with the PDF-content-matches-data gap and the SUPER_ADMIN-scoping gaps on the three untested services.
3. **Module 1 (Accounts/Roles)** — ~~close the SUPER_ADMIN concurrency and JWT-tampering gaps~~ (**both done** — see [01-module1-accounts.md](01-module1-accounts.md); each turned out to need a code fix, not just a test); build the seed script, since it unblocks manual testing of everything else.
4. **Module 2 (Leave Types/Calendar)** — the year-boundary debit test and leave-type-deactivation behavior.
5. **Module 4 (Dashboards)** — lower risk since it composes already-tested endpoints; mainly the SUPER_ADMIN-view gap.
6. **Cross-cutting (Notifications, UI)** — lowest risk, mostly 🟡; the "failed notify doesn't break the action" test is cheap and worth doing early despite being cross-cutting.
7. **Non-functional (E2E, load, security)** — biggest lift, do last as a dedicated effort rather than folding into feature work — an E2E suite in particular is a new tool/setup decision (e.g., Playwright), not just "more tests."
