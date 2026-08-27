# Scope, review criteria, stack & architecture

> Part of the [project rules](../rules.md). These are binding, not advisory.

---

## Scope, NFRs, Module 3 spec & review criteria

### 🧭 General Rules

- Build one module **completely** before moving to the next.
- Never skip architecture layers.
- Follow the project brief before implementing features.
- Keep code simple, readable and maintainable.

---

### 🛡️ Non-Functional Requirements — Non-Negotiable, Applies to Every Module

> From the project brief, reproduced **verbatim, unedited**. These are cross-cutting — they apply to every module past, present and future, not a per-feature checklist. Full status tracking and analysis: [`docs/4.non_functional_requirements.md`](../../docs/4.non_functional_requirements.md) — keep that file updated as each item moves toward being satisfied.

1. Authorization is checked on every request, against the specific record being touched. "Is this user logged in" is not enough; the question is always "is this user allowed to do this, to this row". Write it once in a place you can reason about rather than scattering checks through every handler.
2. A balance must never drift. The number an employee sees has to agree with the history that produced it, after any sequence of approvals, cancellations and overrides. Consider whether a balance is something you store and mutate, or something you derive from a ledger of entries.
3. State transitions are enforced server-side. The set of legal moves from each state should be visible in one place in the code, not implied by scattered conditionals.
4. Every write endpoint validates its input server-side. Never trust the client.
5. The API returns meaningful HTTP status codes and machine-readable error responses. A refused action returns a distinguishable error — "not allowed" and "not found" are different answers, and you should decide deliberately which one an outsider gets.
6. Code must be commented. Every file opens with a short comment saying what it is for, every exported function has a description of its inputs, output and failure modes, and every non-obvious piece of logic — the permission rules, the working-day calculation, the balance arithmetic, the delegation window — carries a comment explaining why it works that way. Comments that merely restate the code are noise; we will call those out too.
7. The app stays responsive with 200 employees and three years of requests.
8. Usable on a phone-width screen. It does not need to be beautiful; it needs to be clear.
9. No secrets, keys or passwords committed to the repository.

> 🔐 **Rule #1's answers live in one document:** [`docs/7.role_permissions_matrix.md`](../../docs/7.role_permissions_matrix.md) is the role capability matrix — what each of `SUPER_ADMIN` / `HR_ADMIN` / `MANAGER` / `EMPLOYEE` can and cannot do, endpoint by endpoint, including the row-level scope attached to each. **Read it before writing any new permission check** (so you reuse the existing scope helpers instead of inventing a fourth notion of "HR's team"), and **update it in the same change whenever a role's abilities change** — see the Documentation section below for the full standing rule.

> ⚠️ **Rule #6 overrides the general "don't write comments unless the why is non-obvious" instinct — for this project specifically, write the file-header comment and the per-function input/output/failure-mode comment every time**, even when it feels repetitive. Applies to every new or changed file from now on. Retrofitting existing files that predate this rule is a tracked backlog item (see the doc above), not something to do silently inside an unrelated change.

---

### 📝 Module 3 — Requests and the Approval Workflow (Authoritative Spec)

> From the project brief, reproduced **verbatim, unedited**. This is the spec for Module 3 (FR-011 through FR-021 in [`docs/1.functional_requirements.md`](../../docs/1.functional_requirements/README.md)) — read this section before writing any leave-request code instead of re-deriving the rules from scratch.

1. An employee submits a request with a leave type, a start and end date, half-day flags, and a reason.
2. Document upload is required where the leave type demands it — for example a medical certificate for sick leave. File type and size are validated on the server; never trust the file extension or the client-reported size. A document is visible only to the requester, their approver and HR.
3. Before submitting, the employee sees exactly how many working days the request will consume, with weekends and public holidays already excluded.
4. A request is refused if it would take the balance below zero, unless that leave type permits a negative balance.
5. A request is refused if it overlaps a request the same employee already has pending or approved.
6. A request moves through the states submitted, approved, rejected, withdrawn and cancelled. Illegal transitions are rejected by the server — an already-cancelled request cannot be approved.
7. A manager approves or rejects a request from their team, leaving a comment. HR can act on any request and can override a manager's decision, which is recorded as an override.
8. An employee can withdraw a request that is still pending, and can cancel an approved request whose dates are still in the future. Both return the days to the balance.
9. Delegation is required. A manager who is going away nominates a delegate for a date range. During that window the delegate can approve requests on the manager's behalf, and the record shows both who acted and who they acted for.
10. Every request carries a full audit trail: each state change with the actor, the timestamp, and any comment. The trail is append-only and never edited.

> 🧭 **Status: built** (migrations 013–017, including file upload — point 2, settled on Cloudinary as the storage backend). Implementation notes, for anyone touching this code next:
> - **Point 2 (document upload)**: `POST /api/leave-requests` accepts `multipart/form-data` with an optional `document` field, required only when `leave_types.requires_document` is true. Real file type is sniffed from content (`utils/fileType.js` — magic bytes, not extension/Content-Type) and restricted to PDF/JPG/PNG, 5MB max (`middlewares/uploadMiddleware.js`, multer memory storage — never touches disk). The file uploads to Cloudinary as a **private `type: authenticated` asset** — a plain Cloudinary URL can never reach it — and Postgres (`leave_request_documents`, migration 017) stores only `cloudinary_public_id`/`cloudinary_resource_type`, never a URL. `GET /api/leave-requests/:id/document` reuses `getLeaveRequestById`'s viewing rule, then mints a signed URL good for 5 minutes (`cloudinaryService.js`) — generated fresh per call, never cached, so there's no long-lived link to leak. Upload happens *after* every other validation (leave type, working days, overlap, balance) and *before* `insertLeaveRequest`, so a Cloudinary failure never leaves a half-created request behind — nothing has touched Postgres yet at that point. A document is immutable once attached (no replace/delete endpoint), matching this table's own `UNIQUE` on `leave_request_id`.
> - Point 3's live preview is `POST /api/leave-requests/preview` — pure, side-effect-free, used by both the frontend's `RequestLeaveForm.jsx` and the real `POST /api/leave-requests` internally, so the number an employee sees before submitting is always exactly what gets charged.
> - Point 6/7's state machine is `leaveRequestStateMachine.js` — `WITHDRAWN`/`CANCELLED` are dead ends (never appear as a `from`); `APPROVED ↔ REJECTED` stays legal only via the two `HR_OVERRIDE_*` actions, gated by `requireRole("HR_ADMIN")` at the route level.
> - Balances are ledger-derived (`leave_balance_ledger`, summed at read time) — see NFR-2 above. `leave_balances.days_taken`/`days_pending` were dropped as columns entirely (migration 014).
> - The two open decisions are settled as: requests spanning a year boundary debit the **start date's** year; only the employee themselves can withdraw/cancel (no HR/manager force-cancel).
> - **One simplification beyond what was originally discussed:** the 403-vs-404 policy (NFR-5) treats "a delegate whose window has expired" the same as "never was a delegate" — both return `404`, not a `403` for the expired case. Distinguishing them would need an extra "did a delegation ever exist for this pair" query for no real security benefit (the action is blocked either way) — don't add that distinction without a concrete reason to.
> - **React gotcha hit while building the live preview:** don't call `setState` synchronously inside a `useEffect` body to "reset" state when preconditions aren't met (e.g. clearing a preview when the date range becomes invalid) — `eslint-plugin-react-hooks`'s `set-state-in-effect` rule flags it, and it's right to: it causes an extra render on every keystroke. Instead, compute a derived boolean (e.g. `hasPreviewableRange`) and gate the *rendering* of the stale value on it, rather than nulling the state out imperatively. See `RequestLeaveForm.jsx`.
> - **Point 7's "HR can act on any request" turned out to mean "any request in their own branch," not company-wide** — this app supports more than one `HR_ADMIN` (each the root of a separate reporting branch; a `MANAGER`'s `manager_id` names one specific HR admin, not the role generically), and the original implementation let *every* HR admin act on *every* request regardless of branch — reported as a real gap once the org actually had more than one HR admin. Fixed in `resolveActingCapacity` (`leaveRequestService.js`): the `HR_ADMIN` branches for approve/reject and for override now call `isUserInSubtree(actor.id, request.employee_id)` (the same recursive-CTE helper `requireUserScope.js`/`reportingService.js` already used elsewhere) instead of returning `{ actedFor: null }` unconditionally; an HR admin outside their own branch gets the same `404` an unrelated manager would (NFR-5 — no more legitimate reason to know than a stranger), not a `403`. `listTeamLeaveRequests`'s `HR_ADMIN` branch changed the same way, from `findAllLeaveRequests()` to `findSubtreeUsers(actor.id)` minus the root itself. Company-wide visibility for HR wasn't removed, just split out: `GET /api/leave-requests/all` (new, `requireRole("HR_ADMIN")`, `listAllLeaveRequests()`) backs the "All Requests" tab on `ApprovalsPage.jsx`, and is deliberately **read-only from the UI's own perspective** — `TeamRequestList`'s new `readOnly` prop hides every approve/reject/override button on that tab (acting still 404s server-side regardless, this is purely so the UI doesn't offer a button that would just fail) — while "My Team" stays the actionable, subtree-scoped tab. Viewing a single request's details (`getLeaveRequestById`, and everything that reuses its rule — audit trail, document) was **not** changed and still lets any HR admin view any request; only the four mutating actions are subtree-scoped.
> - **Point 7 reversed by direct client request: HR no longer decides a request directly, only the employee's actual manager does — HR's role is override-only.** Previously (see the bullet above) HR could approve/reject anything in their own subtree, same as the manager. That subtree-wide bypass is now removed from `resolveActingCapacity`'s APPROVE/REJECT branch — HR falls through to the exact same `isManagerOrDelegateOf(actor.id, request.employee_manager_id)` check as anyone else, and only gets a distinct `403` (not `404`) when blocked, since an in-subtree HR admin still has a legitimate reason to know the request exists (NFR-5). No role-based special-casing was needed to also satisfy "not for manager and HR's [own requests]": `employee_manager_id` already points straight at an `HR_ADMIN` whenever there's no distinct `MANAGER` in between (a `MANAGER`, who per `ALLOWED_MANAGER_ROLES` only ever reports to `HR_ADMIN`, or an `HR_ADMIN` reporting to another `HR_ADMIN`) — so HR is still that literal assigned manager for its own/a manager's leave request, unaffected. The `HR_OVERRIDE_TO_APPROVED`/`HR_OVERRIDE_TO_REJECTED` branch (still subtree-scoped) is untouched, and already only reachable from an already-decided status (`leaveRequestStateMachine.js`), so "manager decides first, HR overrides after" was already enforced by the state machine once the direct-approve bypass was removed — no state-machine change needed. Override's `comment` (`overrideSchema`) changed from optional to **required** at the same time — overturning the actual manager needs a stated reason, unlike a plain approve/reject. Client-side, `RequestActions.jsx` mirrors this via a new `client/src/utils/leaveRequestAuthz.js` (`canDecideDirectly`) so an HR viewer doesn't see Approve/Reject buttons that would just 403 — and the same helper narrows `usePendingApprovalsCount.js`/`TeamOverviewSummary.jsx`'s "N waiting for your decision" counts for HR, which otherwise kept counting the whole subtree, most of which is actually waiting on someone else's decision.
> - **FR-024 (HR reporting/CSV, Module 4) reuses the same "filter server-side, never in JS" principle as everywhere else** — `HrReportsPage.jsx`'s Browse tab hits `GET /api/leave-requests` with `employeeId`/`leaveTypeId`/`status`/`startDate`/`endDate` as query params, resolved by `findLeaveRequestsFiltered` building a dynamic (but still fully parameterized — every value is a placeholder, none are string-concatenated) `WHERE` clause. Deliberately **not** the same query as `GET /all`: that one excludes `WITHDRAWN` (fine for the action-oriented Approvals page, dead weight there), but this is a browse/report view where `WITHDRAWN` is exactly the kind of thing HR might filter *for* — so nothing is excluded by default here. The separate "leave taken per employee" report (`GET /report`, and `GET /report/csv` for the download) is a `GROUP BY` aggregation (`findLeaveTakenReport`) over `APPROVED` requests only ("taken" ≠ pending/rejected/withdrawn/cancelled) overlapping the given period — a request that only partially overlaps is counted in full rather than pro-rated, the same kind of simplification as the year-boundary debit rule for balances above. CSV formatting (`utils/csv.js`, RFC 4180 quoting) lives in the controller, not the service — the service only ever returns structured rows, same layering as the document-download endpoint's `stream`/`filename`/`mimeType` split.
> - **Bug found and fixed after FR-024 shipped: both endpoints above were unscoped by branch** — `listFilteredLeaveRequests`/`generateLeaveTakenReport` originally queried across the whole `leave_requests` table, so *any* HR admin could browse or report on *any* employee, including another HR admin's branch — the exact same "every HR admin, not just company-wide-context views, must stay scoped to their own subtree" rule already established for point 7's approve/reject/override (see the bullet above) and for `listTeamLeaveRequests`, just missed when FR-024 was first built. Fixed the same way: both service functions now take `actor` as their first argument, look up `findSubtreeUsers(actor.id)` minus the root itself, and pass that id list down as `employeeIds` — `findLeaveRequestsFiltered`/`findLeaveTakenReport` AND it into their `WHERE`/`GROUP BY` query (or return `[]` immediately for an HR admin with an empty subtree, without querying at all). An `employeeId` filter for someone outside the caller's subtree now just yields zero rows, same as filtering for an id that doesn't exist — no 403/404 needed since this is a browse view, not a single-record lookup. This does *not* touch `listAllLeaveRequests`/`GET /all`, which stays deliberately company-wide (read-only "All Requests" context, per the bullet above) — the fix is specific to the two FR-024 tools.
> - **Point 9 (delegation) originally had no way for the delegate to find out at all** — `createDelegation` never asked them, and `listTeamLeaveRequests`/`GET /leave-requests/team` was role-gated to `MANAGER`/`HR_ADMIN`, which blocked a plain-`EMPLOYEE` delegate from that endpoint entirely even though the row-level authorization (`isManagerOrDelegateOf`) already let them act on individual requests. Fixed without an accept/reject flow (deliberately — that would need handling rejection too, and nothing in FR-020 asks for one): `GET /api/delegations/as-delegate` (open to any role) is how a delegate discovers the nomination — surfaced via the `DelegateStatus.jsx` dashboard tile and, while a delegation is active, it also reveals the Approvals nav link for a non-manager (`useActiveDelegation.js`, used by both). `listTeamLeaveRequests` now merges in each currently-delegated-for manager's direct reports alongside the actor's own, and the route itself dropped its role gate — an ordinary employee with neither reports nor an active delegation just gets `[]` back, not a `403`. Rows from a delegated-for team are labeled in `TeamRequestList.jsx` ("Delegated for X") using the leave-request row's `manager_first_name`/`manager_last_name` (added to `JOINED_COLUMNS`), since `employee_manager_id` alone doesn't explain to the viewer why an unfamiliar employee's request is in their list.
> - **Point 9, second pass: a delegation and the delegate's own leave were two independent claims on the same days, and nothing reconciled them.** A manager could nominate someone who was already on approved leave, and a delegate could book leave in the middle of a window they were mid-way through serving — in both cases producing an approver who is not there, which is exactly the failure delegation exists to prevent. Five rules now cover it, and the whole design turns on **one distinction: has the delegation window started?** State that before changing any of it, because rules 1 and 3 look contradictory otherwise.
>   1. **Nominating over the delegate's leave is refused (409)** — `assertDelegateIsNotOnLeave` in `delegationService.js`, reusing `findOverlappingLeaveRequest` rather than a new query. Both `SUBMITTED` and `APPROVED` block: a pending request is usually *this manager's own* decision to make, and nominating over it would leave them holding two mutually exclusive commitments; treating pending as blocking also means the guard cannot be defeated by nominating first and approving after. The refusal names the colliding dates (`findOverlappingLeaveRequest` returns `start_date`/`end_date`/`status` now, not just an id) because the manager can already see that employee and a refusal that will not say which dates collide just produces a second failed attempt.
>   2. **Leave inside a window the employee has already *begun* serving is refused (409)** — `assertNotServingDelegation`. 409 not 403: nothing is malformed and nobody is forbidden from taking leave, another record simply claims the same days, same reasoning as the overlapping-request refusal. The message names the window's end date, because "you are a delegate" alone does not tell someone what to do next.
>   3. **Leave overlapping a window that has *not* started is allowed, and warned about** — `DELEGATION_LEAVE_CONFLICT` (migration 044). Refusing would let a nomination the delegate never agreed to veto their leave, and FR-020 deliberately has no accept/reject flow for them to decline through. **Both sides are notified**, with different wording (the `MANAGER_REASSIGNED`/`TEAM_MEMBER_ASSIGNED` precedent): the delegate may not remember being nominated and "contact your manager" is literally their only route; the manager is about to have no cover and would otherwise only find out if the employee remembers to say so — rule 1 closes one direction of this hole, so leaving the manager uninformed would leave the other open. One notification *type* for two recipients here, unlike the overdue sweep's two types, because both land on `/dashboard` — `notificationRouting.js` only needs to split a type when the two audiences need different pages.
>   4. **Leave submitted *while* serving a delegation for the employee's own manager is escalated to HR** — `hr_escalated` on `leave_requests` (migration 043), and the one exception to this app's "HR is override-only" rule. The manager handed their approvals away, so nobody is left to take the *first* decision and the request would sit until `assertPeriodsOpen`'s payroll lock made it undecidable altogether. `resolveActingCapacity` gains a branch above the existing 403: an HR-tier actor whose scope covers the employee may decide it, returning the away manager as `actedFor` so the audit trail reads "HR (on behalf of the manager)" rather than implying HR overruled a decision that was never made. Four things here are load-bearing:
>      - **Only when the delegation is for the employee's *own* manager** (`resolveEscalationForSubmission` compares `delegation.manager_id` against `employee.manager_id`). Covering some other manager says nothing about whether their own manager is available, and escalating those would push work past a manager who is sitting right there.
>      - **Stored, not derived.** The same question could be asked of `delegations` at decision time, but the answer flips the instant the window lapses — so an escalated request nobody got round to deciding would silently stop being HR's to decide, which is the exact dead end the escalation exists to remove.
>      - **Scope-checked, never role-checked alone.** `isInActorsHrScope`, so another branch's HR admin still gets a `404`. And the manager keeps their own authority for when they return: escalation *adds* a decider, it does not move ownership.
>      - **The notification goes to HR *instead of* the manager**, via `resolveNearestHrAncestor(employeeId, { excludeId })` — the `excludeId` exists because an employee reporting straight to HR has that away manager *as* their nearest HR ancestor, so without it the escalation would be delivered to the person who is unavailable.
>   5. **Three client-side pieces are not optional decoration.** `canDecideDirectly` returns true for `hr_escalated` (otherwise HR sees a request the server will let them decide and no button to do it with); `countPendingDecisionsForManagers` gained an employee-keyed `escalatedEmployeeIds` arm — it *has* to be employee-keyed, since an escalated request's assigned manager is by definition not its decider, so the manager-keyed count reads zero while HR has approvals waiting; and `TeamRequestList.jsx` badges the row "Escalated to HR", because HR holding approve/reject on someone else's report — or a manager finding their own report's request already decided by HR — otherwise reads as a permissions bug rather than as the intended routing.
>
>   Two things deliberately *not* built: a delegation revoke/decline endpoint (still none — rule 3 warns rather than refusing precisely because there is nothing for the delegate to decline through), and any recount of escalation when a delegation is edited after the fact (`delegations` has no update endpoint either).

---

### 🎯 Deliverables & Review Criteria (Most Important — read before every module)

> From the project brief, reproduced **verbatim, unedited**. This is what the project is actually judged on — re-read this section before considering any module "done."

#### 7. Deliverables

1. Git repository with a readable commit history — small, meaningful commits, not one commit called "final".
2. A deployed, working URL. Frontend, backend, database and file storage all live. Seed it with a reporting structure at least three levels deep, two leave types, a holiday calendar, and one demo login per role — employee, manager and HR — so a reviewer can log in as each and see the difference immediately.
3. Unit tests. At minimum, cover the working-day calculation across weekends, public holidays and half days; the balance after an approval, a cancellation and an override; overlap detection; rejection of illegal state transitions; and authorization — that a manager cannot act on a request outside their team, that an employee cannot approve their own request, and that a delegate's authority stops when their window ends. Any runner is fine. Tests must run and pass from a single documented command.
4. README covering what the app does, how to run it locally, required environment variables, the architecture and data model, how you modelled permissions and where they are enforced, how balances are calculated, how to run the tests, the significant decisions you made and why, and the known limitations.
5. API documentation. Every endpoint with method, path, the roles allowed to call it, request body, response shape and error cases. A section of the README, a Swagger/OpenAPI page, or a published Postman collection all count.

#### 10. How this will be reviewed

1. Correctness and consistency of authorization. Every endpoint, every record, enforced on the server. This matters most, and we will probe it directly.
2. Correctness of the balance and working-day arithmetic after long sequences of actions.
3. Quality of the unit tests — particularly whether you tested the permission rules, not only the happy path.
4. Whether the permission model and the state machine live somewhere a reader can find them, rather than being spread across handlers.
5. API design: clear resources, correct verbs and status codes.
6. Data model: does it handle the reporting tree, delegation and the audit trail without special-casing?
7. Code readability and comments: naming, structure, no dead code, and explanations where a reader would otherwise have to guess.
8. Documentation quality — a reviewer should get it running from your README alone.
9. Scope discipline: everything in section 4 done well beats extra features done loosely.

**Not assessed: visual flair, animation, or the use of any particular library.**

> 🧭 **What this means in practice, going forward:**
> - **Visual polish is now explicitly off the priority list.** All of this session's UI redesign work stands, but no further time should go into further "make it pretty" passes at the expense of Module 3 correctness/tests/docs — review criterion 9 (scope discipline) explicitly rewards *not* doing that.
> - Deliverable #5 (API docs) is already substantially satisfied by [`docs/2.api_documentation.md`](../../docs/2.api_documentation/README.md) — keep it current (existing standing rule) rather than starting a separate Swagger/Postman effort.
> - Deliverable #3's test list is a **checklist to verify against literally**, not a vibe: working-day calc (weekends + holidays + half-days), balance after approve/cancel/override, overlap detection, illegal-transition rejection, and three specific authorization tests by name — manager acting outside their team, an employee approving their own request, and a delegate acting after their window has ended. Don't consider Module 3's test suite done until all of these exist explicitly, not just implied by broader tests.
> - Deliverable #2 (seed data: 3-level reporting tree, 2 leave types, holiday calendar, one demo login per role) is **done — `npm run seed`** (`server/src/scripts/seedDemo.js`), and it is deliberately much smaller than the deliverable's wording suggests. Surveying both databases first showed the hierarchy (4 deep), 5 active leave types, holidays, leave history and salary structures already existed; the only genuinely missing piece was **a login per role with a password anyone could share**. So it is an *ensure* step that adds three `@example.com` accounts and touches nothing else. Three rules in it are load-bearing and must not be "improved" away:
>   1. **It never creates a leave type or a holiday.** Both are global: creating a leave type backfills a balance row for *every active employee*, and adding a holiday changes the working-day count of every future request in the system. On a database with real records, either is a side effect on people who have nothing to do with the demo. It picks an existing active type instead (entitlement ≥ 5, `requires_document: false` — a document would mean writing to Cloudinary, which nothing cleans up).
>   2. **It never modifies an existing row.** Idempotency is by email lookup, and an email that already exists is reported and left alone — it might be somebody's real account.
>   3. **Demo leave activity goes through `submitLeaveRequest`/`decideLeaveRequest`, never direct inserts.** Balances are ledger-derived and the audit trail is append-only, so hand-written rows would mean hand-maintaining both, against NFR-2. A refusal (holiday on the chosen date, balance too small) is skipped and reported rather than forced.
>
>   Safety shape copied from `migrate:baseline`: plan by default, `--yes` to write, target printed before any write, and a second `--allow-production` flag whenever `NODE_ENV=production` or `DATABASE_URL` is set. **No teardown in v1** — deleting a user cascades through requests, balances, ledger, documents and slips across a mix of `CASCADE` and `RESTRICT` FKs; the manual steps are in `server/README.md` instead. **The 200-employee NFR-7 dataset is explicitly not this script** — different volume, different generation strategy, and it must never share a database with real records.
> - Deliverable #4 wants one README that a reviewer can run the whole app from unaided — currently this project's setup/architecture/decisions are spread across `README.md`, `server/README.md`, `client/README.md`, and `docs/*.md`. That's fine as long as the root `README.md` clearly indexes all of it (which it currently does) — revisit before final submission to make sure nothing a reviewer needs is missing from that chain.
> - Review criterion 4 (permission model and state machine must "live somewhere a reader can find") directly validates the design from the Module 3 spec above: one `assertCanActOnLeaveRequest`-style function and one explicit state-transition map, not logic scattered across controllers.

---

---

## Stack, architecture, file naming & exports

### 🛠️ Technology Stack

| Layer    | Stack |
|----------|-------|
| Backend  | Node.js, Express.js, PostgreSQL, Raw SQL (`pg`), ES Modules |
| Frontend | React (Vite), Axios |
| Testing  | Vitest, Supertest, React Testing Library |

---

### 🏗️ Architecture

```
Client → Routes → Validator → Controller → Service → Repository → PostgreSQL
```

- Do **not** bypass layers.

#### Layer Responsibilities

- **Routes** — endpoints only.
- **Validators** — validate requests only.
- **Controllers** — receive request, call service, return response.
- **Services** — business logic only.
- **Repositories** — database access only.

> ⚠️ **Current gap:** no `validators/` folder exists yet (`userRoutes.js` calls straight into `userController.js`).
> Any **new** endpoint must include a validator file. **Existing** endpoints should get one added before they're changed further.

---

### 🏷️ File Naming & Exports

| Layer      | Suffix           |
|------------|------------------|
| Routes     | `*Routes.js`     |
| Controllers| `*Controller.js` |
| Services   | `*Service.js`    |
| Repositories| `*Repository.js`|
| Validators | `*Validator.js`  |

- Use **named exports only** (`export async function ...`).
- **Never** use default exports in controllers, services, repositories, or validators.

---
