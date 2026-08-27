# Module 3 — leave requests & approval workflow

> Part of [Functional Requirements](README.md). If this disagrees with the code, the code wins.

---

## Module 3: Leave Requests & Approval Workflow

> 📌 The authoritative, verbatim spec for this whole module lives in [`.claude/rules.md`](../../.claude/rules.md) → "Module 3 — Requests and the Approval Workflow". The FRs below are the same requirements broken into individually-trackable checklist items; if the two ever seem to disagree, the rules.md spec wins.

### ✅ FR-011: Submit Leave Request

Employee submits:
- Leave type
- Start date
- End date
- Half-day flags
- Reason

*Implemented via `leaveRequestRepository.js` / `leaveRequestService.js` (`submitLeaveRequest`) / `leaveRequestController.js` (`POST /api/leave-requests`); `leaveRequestValidator.js` validates the shape server-side. Frontend: `RequestLeaveForm.jsx`, opened as a modal from `MyBalancesPage.jsx`. Tested in `leaveRequests.test.js`.*

---

### ✅ FR-012: Document Upload

If leave type requires documents:
- Employee uploads supporting document.
- File type validated.
- File size validated.
- Validation performed on server.
- Document visible only to: Employee, Approver, HR.

*Settled on Cloudinary as the storage backend. `POST /api/leave-requests` accepts `multipart/form-data` with an optional `document` field, required only when the leave type's `requires_document` is true. Real file type is sniffed from content (`utils/fileType.js` — magic bytes, not extension/Content-Type) and restricted to PDF/JPG/PNG, 5MB max (`middlewares/uploadMiddleware.js`, multer memory storage). Uploaded to Cloudinary as a private `type: authenticated` asset — never reachable via a plain URL — with only `cloudinary_public_id`/`cloudinary_resource_type` stored in Postgres (`leave_request_documents`). `GET /api/leave-requests/:id/document` reuses the request's own viewing rule (visible only to the requester, their approver, and HR) and mints a signed URL valid for 5 minutes; `GET /:id/document/download` streams the bytes back with `Content-Disposition: attachment` so the browser saves it instead of navigating to the signed URL. Tested in `leaveRequestDocuments.test.js`.*

---

### ✅ FR-013: Working Day Calculation

Before submission, system calculates leave days excluding:
- Weekends
- Public holidays

*Implemented via `workingDayService.js` (`calculateWorkingDays`) — a pure function excluding weekends and any date covered by a holiday's range, then applying half-day flags. Exposed as a side-effect-free preview (`POST /api/leave-requests/preview`) so the employee sees the exact day count before submitting, using the same calculation the real submission uses. Unit-tested directly in `tests/unit/workingDayService.test.js` (weekends, holidays, half-days, and combinations), plus an integration smoke test.*

---

### ✅ FR-014: Balance Validation

System rejects leave if balance becomes negative, unless the leave type allows negative balance.

*Implemented in `leaveRequestService.submitLeaveRequest` — checks the leave type's `allow_negative_balance` against the current ledger-derived `days_remaining` before inserting the request. Tested in `leaveRequests.test.js` (both the rejection and the allowed-negative-balance case).*

---

### ✅ FR-015: Overlap Detection

Reject request if it overlaps a **pending** or **approved** request of the same employee.

*Implemented via `leaveRequestRepository.findOverlappingLeaveRequest` (same interval-overlap SQL pattern as holidays), scoped to `SUBMITTED`/`APPROVED` requests only. Returns `409`. Tested in `leaveRequests.test.js`.*

---

### ✅ FR-016: Leave Request State Management

Supported states:
- Submitted
- Approved
- Rejected
- Withdrawn
- Cancelled

Illegal state transitions must be rejected.

*Implemented via `leaveRequestStateMachine.js` — a single explicit transition map, checked by every mutating action via `assertLegalTransition`. Illegal moves return `409`. Tested in `leaveRequests.test.js` (e.g. approving an already-withdrawn request).*

---

### ✅ FR-017: Manager Approval

Manager can:
- Approve
- Reject
- Add comments

Only for employees in their team.

*Implemented via `POST /api/leave-requests/:id/approve` \| `/reject`, with an optional `comment`. "Their team" means **direct reports only** (not the full reporting subtree) — a skip-level manager doesn't approve their reports' reports' leave. Row-level scoping (not just a role check) lives in `leaveRequestService.resolveActingCapacity`. Tested in `leaveRequests.test.js`, including the named case: a manager cannot act on a request outside their team (`404`).*

---

### ✅ FR-018: HR Override

HR can:
- Approve
- Reject
- Override manager decisions

Override must be recorded.

*Implemented via `POST /api/leave-requests/:id/override` (`requireRole("HR_ADMIN")`, body `{ toStatus, comment }`), mapped to the `HR_OVERRIDE_TO_APPROVED`/`HR_OVERRIDE_TO_REJECTED` state-machine transitions. Every override writes a normal `audit_logs` row tagged with that specific action name, so it's distinguishable from a plain approve/reject in the trail. Tested in `leaveRequests.test.js`.*

---

### ✅ FR-019: Withdraw & Cancel Leave

Employee can:
- Withdraw a **pending** leave
- Cancel an **approved future** leave

Both restore leave balance.

*Implemented via `POST /api/leave-requests/:id/withdraw` \| `/cancel` — both owner-only (an unrelated caller gets `404`), `cancel` additionally rejects a leave whose `start_date` has already arrived (`400`). Both write a ledger entry releasing the held/taken days. Only the employee themselves can withdraw/cancel — no manager/HR force-cancel (a documented simplification, matching the brief literally). Tested in `leaveRequests.test.js`.*

---

### ✅ FR-020: Delegation

Manager can nominate a delegate. Delegate can approve requests only during the nominated start/end date range.

Audit records:
- Actual actor
- Manager represented

*Implemented via `delegations` table / `delegationService.js` / `POST /api/delegations` (manager-only, `manager_id` always the caller — never client-supplied) / `GET /api/delegations/mine`. A delegate's authority is checked live, per request, via `delegationRepository.findActiveDelegation` (today's date within the delegation's range) — not cached or assumed. `audit_logs.acted_for` records the manager being represented whenever a delegate (not the manager themself) acts. Frontend: `DelegationsPage.jsx` / `DelegationForm.jsx`. Tested in `delegations.test.js` and `leaveRequests.test.js`, including the named case: a delegate's authority stops when their window ends (`404` outside it, `200` inside it).*

**A delegation and the delegate's own leave are reconciled**, since otherwise both could claim the same days and produce an approver who isn't there — the whole failure delegation exists to prevent. Five rules, all turning on whether the delegation window has started:

1. A nomination overlapping the candidate's `SUBMITTED`/`APPROVED` leave is refused (`409`, naming the dates).
2. Leave inside a window the employee has **already begun serving** is refused (`409`, naming the first bookable date).
3. Leave overlapping a window that has **not started** is allowed, and both sides get a `DELEGATION_LEAVE_CONFLICT` notification — refusing would let a nomination the delegate never agreed to veto their leave, and this FR has no accept/reject flow for them to decline through.
4. Leave submitted **while** serving a delegation for the employee's **own** manager is escalated: `leave_requests.hr_escalated`, the submission notification goes to the nearest HR ancestor above the away manager, and HR may decide it directly (recorded as `acted_for` = that manager). Serving a delegation for a *different* manager does not escalate.
5. `GET /leave-requests/pending-count` and the client's `canDecideDirectly` both account for escalated requests, so HR's badge and buttons match what the server will accept.

*Tested in `delegationLeaveRules.test.js` (rules 2–5) and `delegations.test.js` (rule 1).*

---

### ✅ FR-021: Audit Trail

Every request stores:
- State changes
- Actor
- Timestamp
- Comments

Audit trail is append-only.

*Implemented via the `audit_logs` table / `auditLogRepository.js`, which exposes only an `insert` function — no update/delete exists anywhere in the codebase for this table, so append-only is structural, not just a convention. Readable via `GET /api/leave-requests/:id/audit` (same viewing permission as the request itself). Tested in `leaveRequests.test.js`, including the delegate actor-vs-acted-for case.*

---
