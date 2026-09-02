# Performance review, strengths, a full execution example & cheat sheet

> Part of the [Architecture & Workflow Reference](README.md). If this disagrees with the code, the code wins.

---

## Performance review, strengths & weaknesses

### Part 27 — Performance Review

#### N+1 query patterns

**One confirmed instance, low real-world impact**: `listTeamLeaveRequests` (`leaveRequestService.js`) does `Promise.all(delegatedManagerIds.map(managerId => findDirectReports(managerId)))` — one query per manager the actor is currently delegating for. In practice this list is almost always 0 or 1 items, so the cost is negligible, but it's structurally an N+1 shape; a single `WHERE manager_id = ANY($1::uuid[])` query would remove it entirely.

Every other list operation checked (`findAllUsers`, `findSubtreeUsers`, every `leave_requests` listing function, `BALANCE_SELECT`) is a single query with proper `JOIN`s — no loop-per-row pattern found anywhere else in `server/src/repositories/`.

#### Duplicate/repeated queries within one handler

- `decideLeaveRequest` fetches `findLeaveRequestById(requestId)` **twice** — once before the mutation (needed, for authorization + state-machine checks against the *current* row) and once after (purely to return the fresh joined shape). The second fetch re-runs a 5-table `JOIN` just to pick up 4 changed columns (`status`, `decided_by`, `decided_at`, `decision_comment`) that `updateLeaveRequestStatus`'s own `RETURNING` clause already has.
- `userService.changeManager` and `changeStatus` follow the identical "fetch by id → mutate → fetch by id again" shape, at smaller cost (a single `users`⋈`roles` join instead of the 5-table one).

None of these are correctness bugs — they're all one extra round-trip per handler call, worth optimizing only if this system is ever under real load pressure.

#### Pagination

**Since resolved.** The endpoints that grow with time are now paginated on the `limit`/`offset` + `{ rows, total }` contract: `GET /leave-requests/team`, `/all`, `/leave-requests` (HR's filtered browse) and `GET /salary-slips`. Counts that used to be derived by fetching a list are their own endpoints (`/leave-requests/pending-count`, `/users/me/team/count`, `/notifications/unread-count`), and `GET /users/options` is a five-column projection for dropdowns that were pulling ~40 columns per user to render a name.

The team/approvals endpoints take **either** a page **or** a `startDate`+`endDate` window capped at 62 days — the calendar needs a whole month at once, and page 1 of a busy team is not "this month". The window needs no `limit` because its span bounds it, which is why both dates are required together and the cap exists.

What remains unpaginated is bounded by headcount or by leave-type count rather than by time: `/leave-types`, `/holidays` (year-scoped), `/leave-balances/me`, `/employees/:id/documents`, `/delegations/*`, `/leave-requests/:id/audit`, every `/mine` endpoint, and `/report` + `/report/csv` (aggregated to one row per employee — and a CSV export *should* cover everything). Still unmeasured: no load testing has been done either way.

#### Balance calculation — explicitly checked, not an N+1

The self-healing balance-seeding path (`listBalancesForUser`) is two queries total (one `INSERT ... SELECT` for any missing rows, one `SELECT ... GROUP BY` for the actual balances) — not one insert per leave type in a loop.

---

### Part 28 — Architecture Strengths and Weaknesses

#### Strengths

- **Single authorization chokepoint per domain** (`resolveActingCapacity`, `requireUserScope`) rather than scattered per-handler checks — directly satisfies the brief's #1 review criterion and is provably tested (named authorization test cases exist for every documented edge case).
- **Balance-never-drifts is structural, not disciplinary** — there's no code path that *could* desync a balance from its history, because there's no stored total to desync; it's derived every time.
- **One explicit state-transition map** — the entire legal-move set for a leave request is visible in ~10 lines, not implied by conditionals spread across five endpoint handlers.
- **Consistent layering with zero shortcuts** — every resource follows routes→validator→controller→service→repository without exception, confirmed by reading every route file.
- **Deliberate, documented 403-vs-404 policy** (NFR-5) applied consistently, not ad hoc per endpoint.
- **Test coverage matches the brief's explicit checklist by name** — not just broad happy-path coverage, but the specific named authorization edge cases the brief calls out.
- **Self-documenting known gaps** — `docs/2.api_documentation.md`'s "Not yet built" section and the NFR doc's 🟡 markers mean nothing is silently missing; every gap is a decision, not an oversight.

#### Weaknesses (ranked)

**HIGH**
- ~~No rate limiting anywhere in the backend (Part 26).~~ **Closed** — `express-rate-limit` on every pre-auth `/api/auth/*` route (`server/src/middlewares/rateLimiter.js`). No HIGH findings remain.

**MEDIUM**
- No database transactions around multi-statement writes (Part 26/27) — a real, if narrow, data-consistency risk.
- No load testing. The time-growing endpoints are paginated and indexed for it (including `idx_leave_requests_employee_start_date`, which lets a page be walked in order rather than sorted whole), but the NFR-7 target of 200 employees × 3 years has never been measured.

**LOW**
- Minor duplicate-query patterns in `decideLeaveRequest`/`changeManager`/`changeStatus` (Part 27).
- No explicit JWT algorithm pinning.
- Console-logged tokens outside production (by design, but worth revisiting if a shared non-prod environment is ever added).
- `MONTHLY` accrual and holiday-affects-approved-leave are named-but-unimplemented decisions — not wrong, but worth an explicit one-line "decided not to build this, because X" note near the code, matching how well everything *else* in this codebase documents its own scope decisions.

---

---

## Complete execution example & cheat sheet

### Part 29 — Complete Execution Example

```text
Manager clicks "Approve" on a pending request in TeamRequestList
↓
RequestActions.jsx: runAction(() => approveLeaveRequest(request.id))
↓
client/src/services/leaveRequestService.js: approveLeaveRequest(id, comment)
↓
POST /api/leave-requests/:id/approve  { comment }
↓
server/src/routes/leaveRequestRoutes.js — requireAuth (router-wide), no extra role gate for this action
↓
validateParams(leaveRequestIdParamSchema) + validateBody(decisionSchema)
↓
leaveRequestController.js: approve = makeDecisionHandler("APPROVE")
↓
leaveRequestService.js: decideLeaveRequest(req.user, id, "APPROVE", comment)
↓
findLeaveRequestById(id)  →  the joined request row, current status SUBMITTED
↓
resolveActingCapacity(actor, request, "APPROVE")
    → not the owner → not WITHDRAW/CANCEL → not an override action
    → actor.role === "MANAGER" → isManagerOrDelegateOf(actor.id, request.employee_manager_id)
    → employee_manager_id === actor.id → true, direct manager
    → return { actedFor: null }
↓
assertLegalTransition("APPROVE", "SUBMITTED")  →  "APPROVED" (legal move)
↓
ledgerDeltaForAction("APPROVE", workingDays)  →  { pendingDelta: -workingDays, takenDelta: workingDays }
↓
updateLeaveRequestStatus(id, { status:"APPROVED", decidedBy:actor.id, decisionComment:comment })
    → UPDATE leave_requests SET status=$2, decided_by=$3, decided_at=NOW(), decision_comment=$4 ...
↓
insertLedgerEntry({ userId, leaveTypeId, year, leaveRequestId, pendingDelta:-workingDays,
    takenDelta:workingDays, reason:"APPROVE" })
    → INSERT INTO leave_balance_ledger (...) VALUES (...)
↓
insertAuditLog({ leaveRequestId, actorId:actor.id, actedFor:null, action:"APPROVE",
    oldStatus:"SUBMITTED", newStatus:"APPROVED", comment })
    → INSERT INTO audit_logs (...) VALUES (...)
↓
findLeaveRequestById(id)  →  fresh joined row, now status APPROVED
↓
Controller: sendSuccess(res, 200, "Leave request updated", request)
↓
HTTP 200 { success:true, message:"Leave request updated", data:{...status:"APPROVED"...} }
↓
Frontend: RequestActions.runAction — onChanged() called on success
↓
ApprovalsPage.jsx: reload() — bumps reloadToken
↓
useEffect re-fires: getTeamLeaveRequests() (or getAllLeaveRequests() on the All Requests tab)
    + the holidays effect
↓
TeamRequestList re-renders with the updated status; the employee's balance (visible on
    MyBalancesPage/RequestDetailModal) now reflects the ledger's new taken/pending split
    the next time it's fetched — no explicit "push" to the employee's own open tab, since
    there's no websocket/real-time layer in this app (confirmed absent)
```

---

### Part 30 — Final Architecture Cheat Sheet

```text
Frontend:        React 18 (Vite), react-router-dom, Axios, Tailwind CSS, @react-oauth/google, @fullcalendar/*
Backend:         Node.js (ESM) + Express.js
Database:        PostgreSQL, raw parameterized SQL via `pg` — no ORM
Authentication:  Stateless JWT in an httpOnly cookie; 2 paths — password (bcrypt) and Google
                 OAuth (ID token) — both login-only, never signup
Authorization:   resolveActingCapacity() for leave requests; requireUserScope for users/balances —
                 both single reusable functions, not scattered conditionals
Architecture:    Layered REST API: Routes → Validator → Controller → Service → Repository → PostgreSQL
Main Modules:    Auth, Invitations, Users/Reporting, Leave Types, Leave Balances (ledger-derived),
                 Holidays, Leave Requests (submit/decide/report), Delegations
Important Routes: /api/auth/*, /api/users/*, /api/leave-types/*, /api/leave-balances/*,
                 /api/holidays/*, /api/leave-requests/*, /api/delegations/*
Important Controllers: leaveRequestController.js (largest — 13 handlers), authController.js, userController.js
Important Services: leaveRequestService.js (resolveActingCapacity, decideLeaveRequest, submitLeaveRequest),
                 leaveRequestStateMachine.js, workingDayService.js, reportingService.js, authService.js
Important Models: users (self-referencing manager_id tree), leave_requests, leave_balance_ledger
                 (append-only, drives every balance figure), audit_logs (append-only), oauth_accounts
                 (provider-agnostic), delegations
Testing Framework: Vitest both sides; Supertest + a real `_test` Postgres DB for backend integration
                 tests; React Testing Library for frontend component tests
Deployment:      Render — frontend Static Site + backend Web Service, separate subdomains (cross-site,
                 not just cross-origin — cookie needs SameSite=None+Secure in production)
```

### 10 Most Important Things to Remember

1. **Balances are never stored/mutated — they're `SUM()`ed live from an append-only ledger** every single read. This is the structural answer to "how do you keep a balance from drifting."
2. **One function, `resolveActingCapacity`, decides who can approve/reject/withdraw/cancel/override any leave request** — owner-only for withdraw/cancel, never-the-owner for approve/reject/override, then branches HR-subtree vs. direct-manager-or-active-delegate.
3. **One explicit map, `TRANSITIONS`, is the entire legal-state-move universe** for a leave request — nothing else in the codebase changes a request's status.
4. **HR authority for *mutating* actions is scoped per-branch (own reporting subtree), never company-wide** — even though HR can *view* everyone. This app supports multiple HR admins, each rooted at a different branch.
5. **An employee can never act on their own request in any capacity that requires a role** (approve/reject/override) — checked before any role branch, regardless of what other role they might also hold.
6. **403 vs 404 is a deliberate policy, not an accident**: 404 when the caller has no legitimate reason to know a record exists at all; 403 when they already know it exists (it's theirs) but this action isn't theirs to take.
7. **Google OAuth is login-only — never signup.** An unmatched email is a 403, proven-genuine-identity-but-no-permission, distinct from the 401 used for an invalid/unverifiable credential.
8. **`requireAuth` re-fetches the live user from the DB on every request** rather than trusting the JWT payload — this is why deactivating someone or changing their role takes effect on their very next request, not at token expiry.
9. **No ORM and no transactions** — two deliberate/accepted gaps worth being able to name unprompted: raw SQL everywhere (control + recursive CTEs), and multi-statement writes aren't atomic (a real if narrow consistency risk). Rate limiting *was* the third and is now built (`middlewares/rateLimiter.js`): IP-level, on the pre-auth routes only, counting failed sign-ins rather than all of them so a shared office IP is never throttled.
10. **A leave request's `working_days` is snapshotted at submission and never recomputed** — editing the holiday calendar later cannot retroactively change an already-decided request's day count or the balance history it produced. This is also *why* "HR adds a holiday inside already-approved leave" currently does nothing — no code path recalculates existing requests.
