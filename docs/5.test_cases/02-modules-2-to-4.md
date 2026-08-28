# Modules 2–4 — leave setup, requests & dashboards

> Part of [Test Cases](README.md). If this disagrees with the code, the code wins.

---

## Module 2 — leave types, entitlements & calendar

### Module 2: Leave Types, Entitlements & Calendar

#### ✅ Covered

**Server — `leaveTypes.test.js`**
- 401 unauthenticated; HR creates an active leave type; non-HR rejected (403)
- Rejects a duplicate name, case-insensitively (409); rejects a non-0.5-multiple entitlement (422)
- Hides inactive types from non-HR; HR sees them with `includeInactive=true`

**Server — `leaveBalances.test.js`**
- 401 unauthenticated
- Self-heals a missing balance row for a leave type created after the employee existed
- Backfills balance rows for every active employee when HR creates a new leave type
- Seeds balances for a newly invited employee
- Manager can view a subordinate's balances; 403 for an unrelated employee

**Server — `holidays.test.js`**
- 401 unauthenticated; HR can create/update/delete; non-HR rejected (403)
- Multi-day range creation; rejects exact-duplicate or overlapping ranges (409)
- Year-filtering, including a holiday whose range spans a year boundary counting for both years

**Server — `workingDayService.test.js` (unit)**
- Plain Mon–Fri week = 5 days; weekend exclusion; all-weekend range = 0
- Single-day and multi-day holiday exclusion, without double-subtracting a holiday that's already a weekend day
- Half-day at start, half-day at end, half-day at both ends of a multi-day request
- Single-day half-day request = 0.5; a half-day flag on a non-working boundary day is ignored

**Client — `HolidayCalendar.test.jsx`, `HolidayForm.test.jsx`, `HolidayList.test.jsx`, `LeaveTypesPage.test.jsx`, `MyBalancesPage.test.jsx`, `LeaveBalanceCard.test.jsx`, `dates.test.js`**
- Multi-day holidays render one dot per day (FullCalendar quirk workaround); tooltip content; empty state
- Create/edit form: single vs. multi-day, day-count preview, native + server-side backwards-range rejection, overlap error surfaced
- List: day-count badge only for multi-day, "Passed" badge, edit/delete wiring, HR-only controls
- Leave types page: list/create/edit/toggle-active
- Balances page: calendar + request list integration, dot-click highlighting, year-scoped holiday fetch, "show all/less" balance cards
- Balance card rendering; date utilities (`toDateKey` timezone-safety, range formatting, `eachDateKeyInRange` including month-boundary spans)

#### 🔴🟡 Gaps

- 🔴 **No test for a request spanning a year boundary actually debiting the start date's year** — this is an explicitly documented settled business rule (`.claude/rules.md`) but doesn't appear as its own assertion anywhere in `leaveRequests.test.js`. Given it's a rule a reviewer could specifically probe, worth a dedicated test.
- ✅ **Covered (was 🔴): what deactivating a leave type does to existing records.** The behaviour was consistent rather than wrong — nobody had decided whether it was the right behaviour, and neither outcome was visible to the person it affected. Two decisions came out of it. **A discontinued type stays visible in `GET /leave-balances/me` to anyone who has days on it**, flagged `leave_type_active: false` and badged "Discontinued" client-side: the reads filtered on `lt.is_active = true`, so the moment HR retired a type, every employee who had taken it lost all sight of it — the ledger still held the days, but "how many sick days did I take?" simply became unanswerable from the app. A type the employee *never used* stays hidden, since a full untouched entitlement reads as leave they could still take. And **deactivating blocks new requests, not decisions on existing ones** — a request already `SUBMITTED` was raised legitimately and can still be approved — so the response now counts them (`pendingRequests`), because otherwise the type vanishes from the picker while approvals on it keep landing.
- ✅ **Covered (was 🟡): editing an entitlement and its effect on existing balance rows.** `leave_balances.entitlement` is a snapshot taken when the row is created, so editing the type changed nothing for anyone who already had one. The snapshot is deliberate — retroactively rewriting an entitlement changes what people have already been shown — but the consequence was silent: raising Annual Leave from 12 to 15 in June left January's hires on 12 all year while July's got 15, same type, same year, nobody told. `PATCH /leave-types/:id` now takes **`applyToCurrentYear`** (default `false`, so the old behaviour is still the default) and reports `balancesUpdated`. Past years are never touched; they record what people were entitled to then.
- ✅ **Covered (was 🟡): a holiday added *after* an already-approved request — the count did silently go stale, and the balance with it.** `working_days` is computed once at submit, and the ledger entries that moved days into pending or taken used that stored figure, so a holiday declared afterwards (normal, not an edge case) left the employee charged for a day that had become a holiday: five days deducted for a Mon–Fri leave with a Wednesday holiday added later, permanently one day short. The reverse — a holiday deleted in error — under-charged the same way. `POST`/`PATCH`/`DELETE /holidays` now recount every `SUBMITTED`/`APPROVED` request overlapping the affected dates. **The correction is an append, not a rewrite:** `working_days` is updated in place because it is a derived cache, but the balance moves through a new `HOLIDAY_ADJUSTMENT` ledger entry (migration 042), which is what `leave_balance_ledger` is for (NFR-2). A `PATCH` that *moves* a holiday reconciles the union of the old and new ranges — reconciling only the new dates would miss that the old date stopped being a holiday.
- 🟡 No dedicated test that `counts_as_lop` is itself settable/validated at the leave-type API level (only its downstream payroll effect is tested).

**Server — `holidayAdjustment.test.js`** (7 tests)
- A holiday landing inside **approved** leave returns the day: `working_days` 5 → 4, `taken` follows, and the ledger reads `SUBMIT, APPROVE, HOLIDAY_ADJUSTMENT` with a `taken_delta` of `-1`
- A **submitted** request moves its `pending` hold instead — adjusting the wrong column would corrupt a balance in a way that is very hard to see afterwards
- Deleting a holiday inside approved leave takes the day **back**, correcting the under-charge in the other direction
- Moving a holiday out of a leave window still recounts it, because the *old* dates changed meaning too
- A holiday outside every request adjusts nothing and writes no ledger entry
- A **withdrawn** request is ignored — it has already released its days, so recounting it would move a balance for something that no longer affects one
- The employee is notified with **both** figures ("4 working day(s) instead of 5"), since "your leave was recounted" without saying from what to what isn't actionable

**Server — `leaveTypeLifecycle.test.js`** (8 tests)
- A discontinued type stays visible to an employee who used it, flagged `leave_type_active: false`; one they never used stays hidden
- Deactivating reports how many requests are still awaiting a decision; reactivating reports none
- An entitlement edit leaves existing balances alone **by default**, and applies to this year's rows when HR opts in — saying how many moved
- `balancesUpdated` counts rows that genuinely changed, not rows that matched
- A previous year's balances are never touched
- 🟡 No client test confirming `RequestLeaveForm` actually shows/hides the document upload field based on the selected leave type's `requires_document` flag.

---

---

## Module 3 — leave requests & approval

### Module 3: Leave Requests & Approval Workflow

#### ✅ Covered

This is the most thoroughly tested module in the app — and it explicitly satisfies the deliverable checklist from `.claude/rules.md` (working-day calc, balance after approve/cancel/override, overlap detection, illegal-transition rejection, manager-outside-team, self-approval, delegate-after-window-ends — **all present**, see below).

**Server — `leaveRequests.test.js`**
- 401 on `/mine`
- Preview: computes days without persisting; excludes holidays
- Submit: valid submission moves days to pending; rejects zero-working-day ranges (400), overlapping requests (409), negative-balance-inducing requests (400) unless the type allows it
- Lifecycle: approve moves pending→taken; reject releases the pending hold; withdraw (self, pending only) releases the hold; cancel (self, future approved only) zeroes both; rejects cancelling an already-past approved request (400); rejects an illegal transition — approving an already-withdrawn request (409)
- Override: HR overrides rejected→approved correctly moving days; rejects override from non-HR (403)
- **Authorization matrix**: manager outside the team → 404; self-approval → 403; delegate after window ends → 404; delegate within an active window → 200; HR attempting direct approval when the employee has their own manager → 403 (not 404); HR who genuinely is the assigned manager can still approve directly; HR outside their own subtree → 404 (both approve and override); override with no comment → 422
- Listing: `/mine` scoped to self; `/team` scoped to direct reports (manager) or subtree (HR), excluding another HR branch; empty array (not 403) for an employee with no reports/delegation; delegated-for team merged into `/team`
- `/all`: company-wide for HR including other branches; rejected for non-HR (403)
- Audit trail: every transition recorded with actor + comment; records both actor and acted-for identity on a delegate action; names resolved, not raw ids

**Server — `dashboardCounts.test.js`**
- `pending-count` counts a manager's own direct reports' `SUBMITTED` requests and nobody else's, stops counting once a request is decided, and is `0` (not an error) for an employee with no reports
- For HR it counts only what HR is the assigned manager for, not their whole branch
- An active delegation adds that manager's requests to the delegate's count; without one it's `0`
- `on-leave-today` returns only approved leave overlapping today within the caller's team (a pending request dated today and an approved one dated later are both excluded), is company-wide for `SUPER_ADMIN` and branch-scoped for HR, and `[]` for an employee with no team
- `/users/me/team/count` matches `GET /users/me/team`'s own length exactly, and is `0` for someone with no reports

**Server — `leaveRequests.test.js`** (team list pagination and windowing)
- Defaults to one page and reports the total; `offset` honoured with no overlap between pages
- A window returns every request overlapping it, unpaged, and excludes anything outside it
- Rejects a half-open window, a backwards one, one longer than the 62-day cap, and a `limit` above 100

**Server — `salarySlips.test.js`** (pagination)
- The HR list pages with `{ slips, total }`, `total` follows the filters, `/mine` stays a bare unpaginated array, and an over-cap `limit` is 422

**Server — `usersScope.test.js`** (picker projection)
- `GET /users/options` returns only id/name/role/status — the sensitive columns aren't merely masked, they're absent
- Scopes identically to `GET /users` (company-wide for HR, subtree for a manager, self for an employee), and 401s unauthenticated

**Server — `leaveRequestReporting.test.js`** (pagination)
- One page plus the total for the same filters, `offset` honoured, no overlap between pages, newest first
- `total` counts the *filtered* set, not the whole scope
- A `limit` above the cap and a negative `offset` are both `422`

**Server — `leaveRequestReporting.test.js`** (SUPER_ADMIN reporting scope)
- `GET /leave-requests` covers every branch for `SUPER_ADMIN`, including employees it has no HR-write scope over, and an `employeeId` filter for one of them resolves
- `GET /leave-requests/report` includes a deep employee's approved days for `SUPER_ADMIN`, while an `HR_ADMIN`'s report still excludes another branch entirely

**Server — `leaveRequests.test.js`** (company-wide scoping)
- `GET /all` returns every branch's requests for `SUPER_ADMIN`, and **403s an `HR_ADMIN`**
- `GET /:id` is subtree-scoped for `HR_ADMIN` (404 for another branch's request, 200 for their own) while staying company-wide for `SUPER_ADMIN`, so every row of that list stays openable

**Server — `leaveRequestDocuments.test.js`**
- Rejects missing document when required (400); rejects content that isn't really PDF/JPG/PNG regardless of filename (400)
- Accepts a valid PDF; visible only to requester/manager/HR (404 for an outsider)
- Streamed download with correct headers, never the raw signed URL; 404 for no-document metadata lookups

**Server — `leaveRequestReporting.test.js`**
- Browse (`GET /leave-requests`): rejects non-HR (403); filters by employee/type/status (including `WITHDRAWN`, unlike `/all`)/date-range overlap; rejects `endDate < startDate` (422); scoped to caller's own subtree
- Report: rejects non-HR (403); requires both dates (422); sums approved days/count correctly, excludes non-approved statuses, counts partial-overlap requests in full, scoped to subtree
- CSV: rejects non-HR (403); correct content-type/filename/headers/rows

**Server — `delegations.test.js`**
- 401 unauthenticated; rejects non-manager (403); nominate + list via `/mine`; rejects self-delegation (400); rejects overlapping delegation dates (409); `/mine` scoped to the caller only
- Past windows: rejects one whose end date has passed (400); **allows** one that started in the past but hasn't ended, and one covering today only — only the end date is checked
- `/mine` reports a delegate's own overlapping leave (`conflict_leave_*`): names the dates and status for a pending request and for an approved one; null when the delegate's leave sits clear of the window; **ignores a withdrawn request** (matching the nomination guard, so the list and the edit endpoint can't disagree); scoped per delegation, so one manager's clashing window doesn't taint their other one
- `/as-delegate`: 401 unauthenticated; open to a plain employee; empty for nobody-delegated-to; excludes rows where the caller is the nominating manager, not the delegate
- Delegate-on-leave guard: refuses a nomination overlapping the candidate's **approved** leave (409, message names the dates), refuses one overlapping a merely **submitted** request, allows one where the overlapping request was withdrawn, allows one whose window sits clear of the leave

**Server — `holidays.test.js`** (past-dated block)
- Rejects a holiday dated in a **previous year** (400, message names the boundary); allows one earlier in the current year; allows a range starting last year that **ends** in this one
- Rejects *moving* an existing holiday back into a previous year; **still allows renaming** one left over from a previous year, since the update body resends unchanged dates

**Server — `delegationEdit.test.js`** — `PATCH /delegations/:id`. Mostly today-relative for the same reason as `delegationLeaveRules.test.js`: the central rule is defined against the current date
- Access: 401 unauthenticated; 403 non-manager; **404** for another manager's delegation and for one that doesn't exist
- Swap: updates in place (`/mine` still has one row), leaves the untouched window alone, `DELEGATION_REVOKED` to the outgoing delegate and `DELEGATION_NOMINATED` to the incoming one
- Dates only: `DELEGATION_UPDATED` to the same delegate, and **no** revoke
- Re-runs every nomination guard on the merged result: overlap with the manager's *other* delegation (409), a new delegate on leave inside the window (409, naming the dates), self (400), deactivated delegate (400) — plus the regression guard that the row being edited is **not** counted as overlapping itself
- Which rows are editable: in-progress ✅, ending today ✅, already ended ❌ (409)
- Validation: a body that changes nothing (422), a malformed date (422), and a start date that inverts the *stored* window (400 — the validator can't see both halves)

**Server — `delegationLeaveRules.test.js`** — the delegation-vs-own-leave rules on the leave side. Every case is genuinely today-relative (a window is active only with respect to the current date), so this file uses `helpers/dates.js` rather than the fixed 2027 fixtures
- Active window: refuses leave inside a window already being served (409, message names the first bookable date); allows leave after the window ends; a wholly-past window constrains nothing
- Upcoming window: allows the leave and creates a `DELEGATION_LEAVE_CONFLICT` notification for **both** the delegate and the nominating manager, with the right wording each side; the request stays on the ordinary manager-decides path (`hr_escalated: false`)
- Escalation: `hr_escalated: true` and HR can approve directly, with `acted_for` = the away manager in the audit trail; HR is notified and the away manager is not; the escalated request is counted in HR's `pending-count`; the manager can still decide it themselves; **no** escalation when the delegation is for a different manager; HR is **still** refused (403) a direct decision on an ordinary request; an out-of-branch HR admin gets 404 even on an escalated one

**Client — `ApplyLeavePage.test.jsx`, `RequestLeaveForm.test.jsx`, `MyLeaveRequestList.test.jsx`, `RequestActions.test.jsx`, `RequestDetailModal.test.jsx`, `TeamRequestList.test.jsx`, `LeaveRequestTable.test.jsx`, `ApprovalsPage.test.jsx`, `DelegationForm.test.jsx`, `DelegationList.test.jsx`, `DelegateStatus.test.jsx`, `DelegationStatus.test.jsx`, `validation.test.js`**
- Dedicated apply-leave route (not a modal); router-state hand-off of the new request's date back to the balances calendar
- Form: type list, live working-day preview, backwards-range guard, submission wiring, server-error surfacing without clearing the form
- Delegation form/list: create-vs-edit mode (prefill, PATCH instead of POST), and the edit action appearing for upcoming/in-progress windows but never for one that has already ended (the server refuses those, so the button would only fail)
- Delegate-unavailable warning on a delegation row: names the colliding dates, says "approved" vs "requested" leave, keeps the edit action working beside it, and stays silent both when there's no clash and once the window has ended
- Own request list: withdraw/cancel action visibility rules by status and date, decision comment display, calendar-selection highlighting, notification-driven auto-open of the detail modal
- Actions: status-appropriate approve/reject/override buttons, `iconOnly` variant parity, HR-vs-assigned-manager visibility rules **including the `SUPER_ADMIN`-specific case** (hidden unless SUPER_ADMIN is genuinely the assigned manager)
- Detail modal: full data + audit history + balance-in-context + document view/download + inline actions, `readOnly` suppression
- Team list: approve/reject/override wiring, delegated-team badge logic, escalated-to-HR badge presence/absence, `readOnly` mode for the All Requests tab
- `leaveRequestAuthz.test.js`: `canDecideDirectly` across non-HR viewers, HR-who-isn't-the-manager, HR-who-is, and the escalated case for both HR-tier roles
- Read-only browse table; Approvals page tab switching (My Team vs. All Requests) and per-role tab visibility
- Delegation form/status widgets, including multiple simultaneous active delegations

#### 🔴🟡 Gaps

- 🔴 **No test for balance correctness across a long, mixed sequence of actions.** NFR-2 is explicitly the top review criterion ("a balance must never drift... after ANY sequence of approvals, cancellations and overrides") — existing tests each check one or two-step sequences in isolation, not a longer randomized/chained sequence (e.g., submit → approve → HR override to rejected → re-override to approved → cancel).
- 🔴 **No test for a genuine race condition on the overlap check** — two near-simultaneous submissions for the same employee/overlapping dates. All current tests are sequential Supertest calls; nothing proves the overlap check is safe under real concurrent requests (a DB-level exclusion constraint would close this regardless of test coverage — worth checking if one exists).
- 🟡 No test that a `REJECTED` request cannot later be `CANCELLED` (only the `WITHDRAWN`→`APPROVED` illegal transition is explicitly tested).
- 🟡 No test of what happens to an attached document after its parent request is withdrawn/cancelled (does it remain viewable?).
- 🟡 No test of CSV escaping for a comma or a double-quote inside a free-text field (reason/comment) in the exported report.
- 🟡 No test for a holiday being added between a `/preview` call and the actual `POST /leave-requests` submission — could the previewed day-count and the charged day-count disagree?

---

---

## Module 4 — dashboards & reporting

### Module 4: Dashboards & Reporting

#### ✅ Covered

**Server**: No dedicated integration test file — Module 4 introduces no new authorization logic of its own; it composes already-tested Module 1/3 endpoints (user list, team leave requests, reports). Coverage is indirect via those modules' own tests.

**Client — `DashboardPage.test.jsx`, `MyLeaveSummary.test.jsx`, `TeamOverviewSummary.test.jsx`, `HrReportsPage.test.jsx`**
- Dashboard: manager/HR display without duplication when the manager is also HR; nothing extra for a manager-less root HR admin
- My-leave summary tile: balance chips with distinct accents, pending count, next upcoming leave, most recent decision
- Team overview tile: headcount, pending-approvals review link (and its absence), who's out today (including half-day formatting)
- HR Reports page: Browse Requests tab (filtering, employee search, read-only), Leave Report tab (generate/empty-state/CSV link/disable-until-both-dates/Clear/one-click presets)

#### 🔴🟡 Gaps

- 🔴 **No test of dashboard behavior specifically for `SUPER_ADMIN`.** `superAdmin.test.js` proves the service-layer scoping (direct reports only), but no client test confirms `TeamOverviewSummary`/`DashboardPage` correctly reflect that narrower scope when rendered for a `SUPER_ADMIN` viewer, as opposed to a full-subtree `HR_ADMIN`.
- 🟡 No test confirming the HR Reports CSV **download link's actual file content** is correct — reasonable, since that's a real browser navigation outside RTL's reach, but worth a manual QA checklist item.

---
