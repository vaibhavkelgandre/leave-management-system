# Leave requests

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Leave Requests (`/api/leave-requests`)

Every route below requires `requireAuth`. `working_days` is computed server-side and snapshotted on the request at submission — it never changes afterward, even if the holiday calendar is edited later. The row shape returned by every read endpoint below is:
```json
{
  "id": "...", "employee_id": "...", "leave_type_id": "...", "leave_type_name": "Annual Leave",
  "start_date": "2027-01-04", "end_date": "2027-01-05", "start_half_day": false, "end_half_day": false,
  "working_days": "2.0", "reason": "...", "status": "SUBMITTED",
  "decided_by": null, "decided_at": null, "decision_comment": null,
  "decided_by_first_name": null, "decided_by_last_name": null,
  "employee_first_name": "...", "employee_last_name": "...", "employee_email": "...", "employee_manager_id": "...", "employee_role": "EMPLOYEE",
  "manager_first_name": "...", "manager_last_name": "...",
  "has_document": false,
  "created_at": "...", "updated_at": "..."
}
```
`decided_by_first_name`/`decided_by_last_name` are resolved server-side from `decided_by` (null until the request is decided) so the UI never has to show a raw user id. `has_document` (FR-012) tells the UI whether to show a "view document" action, without a client needing to call `GET /:id/document` on every row just to find out. `manager_first_name`/`manager_last_name` name the employee's own manager (`employee_manager_id`) — used by `GET /api/leave-requests/team` so the UI can label a row "delegated for X" when it belongs to a manager other than the viewer themself (see that route below). `employee_email` lets a team/approvals view disambiguate same-named employees without a second lookup.

**403 vs. 404, applied deliberately across every route below** (NFR-5): if the caller has no legitimate reason to know a request exists at all (an unrelated manager, an unrelated employee, or a delegate whose window has lapsed), the response is **404** — not a 403 that would confirm the id is real. If the caller already knows the request exists because it's their own, but this specific action isn't theirs to take (e.g. approving your own request), the response is **403**.

### `POST /api/leave-requests/preview`

Computes the working-day count for a candidate date range **without creating anything** — lets the employee see exactly how many days a request will use before submitting.

**Auth**: any authenticated role.

**Body**
```json
{ "startDate": "YYYY-MM-DD, required", "endDate": "YYYY-MM-DD, required, >= startDate", "startHalfDay": "boolean, optional", "endHalfDay": "boolean, optional" }
```

**Response** `200` — `{ "workingDays": 4.5 }`.

**Errors**: `422` validation (backwards range, or both half-day flags set on a single-day range).

---

### `POST /api/leave-requests`

Submits a leave request. `employee_id` is always the caller — never client-supplied.

**Auth**: any authenticated role.

**Body**: same shape as `/preview`, plus `leaveTypeId` (UUID, required) and `reason` (string, required).

Accepts either `application/json` (no document) or `multipart/form-data` (all the same fields sent as form fields, plus an optional `document` file field) — send `multipart/form-data` whenever a document is attached, required or not. `startHalfDay`/`endHalfDay` may arrive as the strings `"true"`/`"false"` in the multipart case; the server coerces them.

**Document field (FR-012)**: required when the chosen leave type has `requires_document: true` (e.g. a medical certificate for sick leave), optional otherwise. Accepted types are PDF, JPG and PNG, verified from the file's actual content — not its extension or declared Content-Type. Max size 5MB. The file is stored in Cloudinary as a private (`authenticated`) asset; nothing about it is ever returned in this response — fetch it separately via `GET /api/leave-requests/:id/document`. A document is immutable once attached — there is no replace/delete endpoint.

**Response** `201` — the created request (`status: "SUBMITTED"`), **except for `SUPER_ADMIN`**: since nobody is positioned to review its own leave, the request is created directly as `status: "APPROVED"` with `decided_by` set to itself — it never passes through `SUBMITTED`, and no `LEAVE_REQUEST_SUBMITTED` notification fires (there's no recipient). Every other check above still applies unchanged (leave type active, working-day count, overlap, balance, document requirement) — the bypass only skips *who decides*, not the data-integrity checks.

**Errors**: `400` leave type inactive/not found, range has zero working days, the balance would go negative and the leave type doesn't allow it, the leave type requires a document and none was attached, the attached file exceeds 5MB, or its real content isn't PDF/JPG/PNG · `409` overlaps an existing `SUBMITTED`/`APPROVED` request of the caller's · `422` validation.

---

### `GET /api/leave-requests/mine`

The caller's own requests, newest start date first.

**Auth**: any authenticated role.

**Response** `200` — array of the row shape above.

---

### `GET /api/leave-requests/team`

**Paginated, in two bounded shapes** — and never unbounded:

| Params | Returns | Used by |
|---|---|---|
| `limit` (1–100, default **25**) + `offset` | one page, newest first | the approvals list |
| `startDate` + `endDate` (both required together, span ≤ **62 days**) | *everything* overlapping the window, unpaged | the approvals calendar, which needs a whole month at once |

Response is `{ "requests": [...], "total": N }` either way — the same envelope as `GET /notifications`. A window needs no `limit` because the window bounds it; that's why both dates are required together and the span is capped, otherwise `?startDate=1900-01-01&endDate=2100-01-01` would be the unbounded query this endpoint was paginated to remove.

Requests the caller can act on: **direct reports only** for a `MANAGER` (not the full reporting subtree — approval authority belongs to the direct manager or their delegate, not a skip-level manager), plus — for whatever part of today falls inside an active delegation naming the caller as delegate — that delegated manager's direct reports too. For `HR_ADMIN`, their **own full reporting subtree** (every manager/employee under them, however many levels deep) — this app supports more than one `HR_ADMIN`, each the root of a separate branch (a `MANAGER`'s `manager_id` names one specific HR admin, not the role generically), so this is *their* team, not the whole company. For the whole company, see `GET /all` below.

**Auth**: any authenticated role — **not** role-gated at the route, unlike most team-scoped endpoints. A delegate can be a plain `EMPLOYEE` with no reports of their own (nothing checks the candidate's role in `POST /api/delegations`), and still needs this endpoint to see the team they're covering. An `EMPLOYEE` who is nobody's delegate and has no reports simply gets back `[]`, not a `403`.

**Response** `200` — array of the row shape above. Rows from a delegated-for manager's team have `employee_manager_id` different from the caller's own id — use `manager_first_name`/`manager_last_name` to label those rows in the UI.

---

### `GET /api/leave-requests/pending-count`

How many requests are waiting on **this caller's** decision right now: `{ "count": 3 }`.

A count endpoint, not a list the client counts — the sidebar's Approvals badge asks for this on every page load, and the team list it used to filter is thousands of rows and several megabytes at NFR-7's "200 employees, three years" target. Same relationship as `GET /notifications/unread-count` to `GET /notifications`.

The rule matches what the caller could actually decide today: the employee's assigned manager is the caller, **or** a manager the caller is currently an active delegate for. For an `HR_ADMIN`/`SUPER_ADMIN` this is narrower than "every `SUBMITTED` row in my branch" — their list spans the branch for visibility, but most of it is still the actual manager's call to make first. (Known gap, preserved deliberately: an HR-tier caller who is *also* an active delegate doesn't get those delegated rows counted, because `GET /team` doesn't list them for HR either.)

**Auth**: any authenticated role — no role gate. Scoped to the caller like `/team` is, so an employee with nobody reporting to them gets `0`, not a `403`.

**Response** `200` — `{ "success": true, "message": "Pending count retrieved", "data": { "count": 3 } }`

---

### `GET /api/leave-requests/on-leave-today`

Approved leave overlapping **today**, for whoever the caller can see — the dashboard's "on leave today" table. Same row shape as `GET /team`; typically a handful of rows rather than the whole history the client used to filter down from.

Scoped like `/team` (direct reports + any actively delegated team for a manager, own branch for `HR_ADMIN`) with one exception: **`SUPER_ADMIN` is company-wide**, matching the company-wide list it alone may fetch and the whole-company headcount it already sees.

**Auth**: any authenticated role — no role gate, scoped server-side. An employee with no team gets `[]`.

**Response** `200` — array of the row shape above.

---

### `GET /api/leave-requests/all`

Every leave request in the system, newest first, excluding `WITHDRAWN` — a read-only browse/context view. **Paginated exactly like `GET /team` above** (a page, or a ≤62-day window for the calendar), same `{ requests, total }` envelope.

**`SUPER_ADMIN` only** (narrowed from HR_ADMIN+SUPER_ADMIN on direct request). An `HR_ADMIN` gets **403** here: their view of leave is their own reporting branch, which `GET /team` already returns, so a scoped version of this endpoint would have been the same rows under a second name. The company-wide view belongs to the one role sitting above every branch.

**Auth**: `SUPER_ADMIN` only.

**Response** `200` — array of the row shape above.

**Errors**: `403` caller isn't `SUPER_ADMIN` (including every `HR_ADMIN`).

---

### `GET /api/leave-requests`

FR-024: HR's filterable browse view — every query param is optional, and any combination may be used together. Resolved entirely server-side by a dynamic (but still fully parameterized) SQL `WHERE` clause — never a client-side filter over an already-fetched list. Unlike `GET /all` above, **nothing is excluded by default**: a `WITHDRAWN`/`CANCELLED` request is exactly the kind of thing HR might filter *for* when browsing history, not dead weight to hide the way it is on the action-oriented approvals views.

**Paginated.** `limit` (1–100, default **25**) and `offset` (≥ 0, default 0) join the filters, and the response is an envelope rather than a bare array — the same `{ rows, total }` contract as `GET /notifications`, because the unfiltered default case here is *every* request in the caller's scope (thousands of rows at NFR-7's target, and HR's browse tab loads with no filters applied). `total` is the count for the same filters, so a client can render "showing 1–25 of 4,312" and know whether a next page exists. Ordered `start_date DESC`, backed by `idx_leave_requests_employee_start_date` (migration 037) so a page doesn't sort the whole matching set first.

**Auth**: `HR_ADMIN`/`SUPER_ADMIN`. For an `HR_ADMIN`, scoped to their own reporting subtree — one HR admin can never browse another HR admin's branch here (see NFR-1), and an `employeeId` filter for someone outside their subtree simply returns no rows. **`SUPER_ADMIN` is company-wide** (direct request): reusing its narrower HR-*write* scope (direct-report `HR_ADMIN`s only) would have given the one role that can already read every request a browse view of almost nobody.

**Query params** (all optional)
```
employeeId   string (UUID)
leaveTypeId  string (UUID)
status       SUBMITTED | APPROVED | REJECTED | WITHDRAWN | CANCELLED
startDate    YYYY-MM-DD
endDate      YYYY-MM-DD, must be >= startDate if both given
```
`startDate`/`endDate` use the standard interval-overlap test (does the request's own date range overlap this window at all) — the same shape already used for holidays and overlap detection elsewhere, not exact containment.

**Response** `200` — array of the row shape above, newest start date first.

**Errors**: `403` caller isn't `HR_ADMIN` · `422` `endDate` before `startDate`, or a malformed `employeeId`/`leaveTypeId`/`status`.

---

### `GET /api/leave-requests/report`

FR-024: "a report of leave taken per employee over a period" — one row per employee with at least one `APPROVED` request overlapping `[startDate, endDate]`. "Taken" means `APPROVED` specifically; pending, rejected, withdrawn, and cancelled requests never actually consumed leave. A request that only partially overlaps the period is counted in full (its whole snapshotted `working_days`), not pro-rated to just the overlapping days — a documented simplification, the same kind already made for the year-boundary debit rule on balances.

**Auth**: `HR_ADMIN`/`SUPER_ADMIN`, scoped exactly as `GET /api/leave-requests` above — an `HR_ADMIN`'s own subtree (nobody from another branch ever appears), and **company-wide for `SUPER_ADMIN`**, so the leave-taken report covers every employee.

**Query params** (both required — unlike the browse filters above, a report needs an explicit period)
```
startDate   YYYY-MM-DD
endDate     YYYY-MM-DD, must be >= startDate
```

**Response** `200`
```json
[
  { "employee_id": "...", "employee_first_name": "...", "employee_last_name": "...", "employee_role": "EMPLOYEE", "request_count": 2, "total_days_taken": "3" }
]
```

**Errors**: `403` caller isn't `HR_ADMIN` · `422` missing/malformed `startDate`/`endDate`, or `endDate` before `startDate`.

---

### `GET /api/leave-requests/report/csv`

Same report and same query params as `GET /report` above, streamed back as a CSV file (`Content-Type: text/csv`, `Content-Disposition: attachment; filename="leave-report-<startDate>-to-<endDate>.csv"`) instead of the JSON envelope. Columns: First Name, Last Name, Role, Requests, Total Days Taken.

**Auth**: `HR_ADMIN` only.

**Response** `200` — raw CSV text, not the JSON envelope.

**Errors**: same as `GET /report`.

---

### `GET /api/leave-requests/:id`

Fetches a single request.

**Auth**: the request's own employee, their direct manager, an active delegate for that manager, an `HR_ADMIN` **whose own reporting subtree contains that employee**, or `SUPER_ADMIN` (company-wide).

The `HR_ADMIN` case is subtree-scoped rather than company-wide, narrowed alongside `GET /all` — an HR admin who can't see another branch's requests in a list shouldn't be able to fetch one by id either. `SUPER_ADMIN` stays company-wide precisely so it agrees with the company-wide list they alone can fetch; otherwise every row in that list would 404 on the way to its own detail view. The same rule covers `/:id/audit`, `/:id/document` and `/:id/document/download`, which all piggyback on this check.

**Errors**: `404` not found or out of the caller's view.

---

### `GET /api/leave-requests/:id/audit`

The request's full audit trail (FR-021), oldest first. Same viewing permission as `GET /api/leave-requests/:id`.

**Auth**: same as `GET /api/leave-requests/:id`.

**Response** `200`
```json
[
  {
    "id": "...", "leave_request_id": "...", "actor_id": "...", "acted_for": null,
    "action": "SUBMIT", "old_status": null, "new_status": "SUBMITTED", "comment": null, "created_at": "...",
    "actor_first_name": "Asha", "actor_last_name": "Employee",
    "acted_for_first_name": null, "acted_for_last_name": null
  }
]
```
`acted_for` (and `acted_for_first_name`/`acted_for_last_name`) is set only when a delegate (not the manager themself) performed the action. `actor_first_name`/`actor_last_name` are resolved server-side so the UI never has to show a raw user id.

---

### `GET /api/leave-requests/:id/document`

Returns a short-lived download link for the request's attached document, if any (FR-012). Same viewing permission as `GET /api/leave-requests/:id` — "visible only to the requester, their approver and HR." Nothing is cached server-side: the signed URL is generated fresh on every call and expires five minutes after issuance, so there's never a long-lived link that could be shared beyond the people this endpoint already authorized.

**Auth**: same as `GET /api/leave-requests/:id`.

**Response** `200`
```json
{ "url": "https://res.cloudinary.com/.../signed-and-time-limited", "filename": "medical-certificate.pdf", "mimeType": "application/pdf" }
```

**Errors**: `404` request not found/out of the caller's view, or the request has no document attached.

---

### `GET /api/leave-requests/:id/document/download`

Streams the request's attached document back as the response body with `Content-Disposition: attachment`, so the browser saves it to disk instead of navigating to it — a plain link to the signed Cloudinary URL above ignores an `<a download>` attribute across origins and just opens the file instead. Same viewing permission, and the same authorization check, as `GET /api/leave-requests/:id/document` (this endpoint calls it internally before fetching the bytes).

**Auth**: same as `GET /api/leave-requests/:id`.

**Response** `200` — raw file bytes, not the JSON envelope. `Content-Type` is the document's real MIME type; `Content-Disposition` is `attachment; filename="<original filename>"`.

**Errors**: same as `GET /api/leave-requests/:id/document` — `404` request not found/out of the caller's view, or the request has no document attached.

---

### `POST /api/leave-requests/:id/approve` · `/reject`

Approves or rejects a `SUBMITTED` request.

**Auth**: only the request's direct manager, or an active delegate for that manager — **never** the request's own employee, regardless of role (this is what the "employee cannot approve their own request" rule enforces). **HR no longer has a blanket right to decide directly** (client-requested change): an `HR_ADMIN` can only approve/reject here when HR genuinely *is* the assigned manager (an employee with no distinct manager, or a `MANAGER`/`HR_ADMIN` whose own manager is HR) — HR admins who aren't the direct manager must wait for that manager's decision and use `/override` afterward. An `HR_ADMIN` whose subtree includes this employee but isn't the direct manager gets `403` (they have a legitimate reason to know the request exists — see `404` below for the alternative); an `HR_ADMIN` outside their subtree entirely is treated exactly like an unrelated manager (`404`).

**Body**
```json
{ "comment": "string, optional" }
```

**Response** `200` — the updated request (`status: "APPROVED"` or `"REJECTED"`).

**Errors**: `403` caller is the request's own employee, or an HR admin in-subtree but not the assigned manager · `404` caller has no relationship to this request at all (including an HR admin outside their own branch) · `409` request isn't `SUBMITTED`, **or the period is closed by an issued payslip (see below)** · `422` validation.

> 🔒 **Payroll lock.** A decision is refused with **`409`** when the request overlaps any pay period for which *that employee* already holds an `ACTIVE` payslip. A payslip stores `lop_days` as a snapshot and payroll only runs for a fully-completed period, so a decision landing after the run would leave the slip and the leave record disagreeing — most often as a silent overpayment, since nobody queries a payslip that came out too high. The message names the period and the way out: **HR voids that payslip, which reopens the period for that employee only**, then the decision goes through and payroll is re-run. Applies to `/approve`, `/reject` and `/override`; a request spanning two months is locked if **either** month has a slip, because a request is charged in full to every period it overlaps. `/withdraw` is deliberately **not** locked — a `SUBMITTED` request never counted toward LOP, so withdrawing it cannot invalidate a slip, and it stays the employee's exit for a request that can no longer be decided.

---

### `POST /api/leave-requests/:id/withdraw`

Withdraws a `SUBMITTED` request, releasing the held (pending) days.

**Auth**: the request's own employee only.

**Errors**: `404` caller isn't the owner · `409` request isn't `SUBMITTED`.

---

### `POST /api/leave-requests/:id/cancel`

Cancels an `APPROVED` request whose `start_date` hasn't arrived yet, releasing the taken days.

**Auth**: the request's own employee only.

**Errors**: `400` the leave has already started · `404` caller isn't the owner · `409` request isn't `APPROVED`.

---

### `POST /api/leave-requests/:id/override`

HR overrides an already-decided request in either direction. This is now HR's *only* way to influence a request whose direct manager isn't HR itself — the flow is always employee submits → the actual manager decides → HR may override afterward, with a reason.

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree — the route itself is a plain role check ("must be *some* HR admin"), but which requests a given HR admin can actually override is scoped via the same row-level subtree check `/approve`/`/reject` used to use directly. An `HR_ADMIN` outside their own branch gets the same `404` an unrelated manager would, not a `403` — they have no more legitimate reason to know this request exists. **`SUPER_ADMIN` is deliberately excluded** — it never has override power, anywhere, for anyone (403, same as any non-HR caller) — a direct-report `HR_ADMIN`'s own leave is already fully handled via the plain manager-approve path (see `POST /leave-requests`), and this endpoint's real purpose (revisiting a decision already made about an *employee*, inside a subordinate `HR_ADMIN`'s own branch) is exactly the kind of reach into a subordinate's team that `SUPER_ADMIN`'s scope is designed to exclude.

**Body**
```json
{ "toStatus": "APPROVED | REJECTED", "comment": "string, required — a reason is required to override a decision" }
```

**Response** `200` — the updated request. Recorded in the audit trail as `HR_OVERRIDE_TO_APPROVED`/`HR_OVERRIDE_TO_REJECTED`, distinguishable from a plain approve/reject.

**Errors**: `403` caller isn't `HR_ADMIN` at all (including `SUPER_ADMIN`) · `404` caller is HR but this request is outside their own reporting subtree · `409` `toStatus: "APPROVED"` on a request that isn't `REJECTED` (or vice versa), **or the period is closed by an issued payslip** (see the payroll lock note under `/approve` · `/reject` — an override is the most likely way to hit it, since it acts on an already-decided request) · `422` validation, including a missing/blank `comment`.

---
