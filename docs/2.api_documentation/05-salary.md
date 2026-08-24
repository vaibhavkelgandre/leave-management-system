# Salary slips & salary structures

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Salary Slips (`/api/salary-slips`)

Module 5 v2 (FR-025), added beyond the original brief. Every route below requires `requireAuth`. A slip is visible only to the employee it belongs to and to HR — never to their manager. HR's authority is scoped to their own reporting subtree (same as every other HR-scoped feature in this app) — never company-wide. Replaces the earlier bulk-CSV design: HR assigns a [salary structure](#salary-structures-apiemployeesidsalary-structure) once per employee, and a pay period is **calculated** from that structure plus LOP, not uploaded.

The row shape returned by every read endpoint below:
```json
{
  "id": "...", "employee_id": "...", "pay_period": "2026-03",
  "basic_pay": "30000.00", "hra": "12000.00", "pf_employee_contribution": "1800.00", "pf_employer_contribution": "1800.00",
  "esic": "0.00", "special_allowance": "5000.00", "lop_days": "1.0", "lop_deduction": "1566.67",
  "total_leave_days": "3.0", "payable_days": "30.0",
  "income_tax": "0.00", "net_pay": "43633.33",
  "status": "ACTIVE", "voided_by": null, "voided_at": null, "void_reason": null,
  "created_by": "...", "updated_by": null,
  "employee_first_name": "...", "employee_last_name": "...", "employee_email": "...",
  "created_at": "...", "updated_at": "..."
}
```
`net_pay` = `basic_pay + hra + special_allowance - pf_employee_contribution - esic - income_tax - lop_deduction - <pre-joining-days deduction, if joining_date falls within the period>`. `pf_employer_contribution` is recorded for the payslip but never subtracted — it's a company cost, not paid out of the employee's earnings. `lop_deduction` = `(basic_pay + hra + special_allowance) / <calendar days in pay_period> × lop_days`. `payable_days` is how many of the period's days the earnings figure was actually based on — the full month minus `lop_days` and, for an employee who joined partway through the period, minus the days before `joining_date` too (see `/calculate` above). `total_leave_days` is every `APPROVED` leave day in the period regardless of leave type — a superset of `lop_days`, which only counts leave types flagged `counts_as_lop`. `status` is `ACTIVE` or `VOIDED` (see `POST /:id/void` below); `voided_by`/`voided_at`/`void_reason` are only set once voided.

### `POST /api/salary-slips/calculate`

For every employee in the caller's reporting subtree with a `VERIFIED` profile (see [Employee Onboarding](#employee-onboarding--profile-verification-apiemployees)) **and** a salary structure assigned, computes LOP (sum of `working_days` on `APPROVED` requests of any leave type flagged `counts_as_lop`, overlapping the period), total leave days (the same sum across **every** leave type, not just LOP), and the resulting net pay — **writes nothing**. Anyone missing either prerequisite, or not yet employed for this period (see below), is reported as `skipped` with a reason, never silently omitted. The first step of the required calculate-then-confirm flow.

`payPeriod` must be a **fully completed past month** — its last day must already be before today. A period that hasn't started yet, or has started but not finished (this month, mid-month), both reject with `400`: HR can only run "last month's numbers this month," never a preview of the still-running current month.

**Row `status` is one of three values**, not two:

| `status` | Meaning | Committed by `/confirm`? |
|---|---|---|
| `ok` | Payroll-ready, figures computed | Yes |
| `skipped` | Something is in the way — no `VERIFIED` profile, no salary structure, **account no longer `ACTIVE`**, not yet joined, **already left before this period**, or **net pay works out to zero or less** | No |
| `already_generated` | This employee already holds an `ACTIVE` slip for this period | No |

`already_generated` is reported **here, in the preview**, not just at confirm time: previously this row came back as `ok`, so HR read "Ready" for an employee who was then silently skipped on approve. `computed` is `null` for those rows — recomputing figures that can't be committed would only raise the question of why they differ from the slip the employee actually keeps. A `VOIDED` slip doesn't count, so voiding returns that employee to `ok` and reopens the period for a corrected run.

**A net pay of zero or less is skipped, never issued.** This happens for real — a full month of unpaid leave, or configured deductions (PF + ESIC + income tax) that meet or exceed earnings. A zero-value payslip reads to the employee as "you were paid ₹0" and occupies the `(employee, pay_period)` slot, so the corrected run would have to void it first. The figures stay attached to the row (`computed` is populated) so HR can see *why* it came to zero.

Employment is bounded at **both** ends, symmetrically, from the two HR-set dates (`PATCH /api/employees/:id/employment-dates` — never self-editable, since both determine pay):

- `joining_date` **after** the period ends → `skipped`, `skipReason: "Not yet joined for this period"`.
- `last_working_day` **before** the period starts → `skipped`, `skipReason: "Already left before this period"`. Without this, setting a leaving date would pro-rate the exit month correctly and then keep issuing *full* payslips every month afterwards.
- `status !== 'ACTIVE'` → `skipped`, `skipReason: "Account is no longer active"`. Reported separately from the leaving date because the two mean different things to HR: one is an account switched off, the other is an employment end date on record. Payroll previously ignored `status` entirely, so a deactivated employee with a verified profile and a salary structure kept receiving a full payslip, emailed to them, every month.
- Either date falling **within** the period pro-rates earnings: the per-day rate still divides by the full calendar days in the month, but only days inside the employed window count as payable (further reduced by any LOP in that range) — see `payableDays` below. A leaving date on or after the month end pro-rates nothing, so a notice period ending in a later month is handled by the same comparison with no special case.
- Both leave queries are clamped to the employed window at **both** ends: leave dated after someone left can no more exist than leave dated before they joined.

Fixed deductions (PF, ESIC, income tax) are flat configured amounts and are never pro-rated — only the earnings component shrinks, exactly as LOP has always behaved.

`role`/`profileStatus` (both optional) pre-filter the subtree *before* any of the above — e.g. `role: "EMPLOYEE"` excludes managers and other HR admins outright, rather than computing them and discarding the result. Whatever filters were used for `/calculate` should be repeated identically on the following `/confirm` call, so what's committed matches what was previewed.

**Auth**: `HR_ADMIN` only.

**Body**: `{ "payPeriod": "YYYY-MM, required", "role": "EMPLOYEE | MANAGER | HR_ADMIN, optional", "profileStatus": "INCOMPLETE | SUBMITTED | VERIFIED, optional" }`

**Response** `200`
```json
{
  "summary": { "total": 3, "ok": 1, "skipped": 1, "alreadyGenerated": 1 },
  "rows": [
    {
      "employeeId": "...", "employeeName": "...",
      "status": "ok", "skipReason": null,
      "computed": { "basicPay": 30000, "hra": 12000, "pfEmployeeContribution": 1800, "pfEmployerContribution": 1800, "esic": 0, "specialAllowance": 5000, "lopDays": 1, "lopDeduction": 1566.67, "totalLeaveDays": 3, "payableDays": 30, "incomeTax": 0, "netPay": 43633.33 }
    },
    { "employeeId": "...", "employeeName": "...", "status": "skipped", "skipReason": "No salary structure assigned", "computed": null },
    { "employeeId": "...", "employeeName": "...", "status": "already_generated", "skipReason": "Already received a payslip for this period — void the existing slip first to re-run", "computed": null }
  ]
}
```

`ok + skipped + alreadyGenerated === total`, always.

**Errors**: `403` caller isn't `HR_ADMIN` · `422` `payPeriod` missing/malformed · `400` `payPeriod` hasn't fully ended yet.

---

### `POST /api/salary-slips/confirm`

Re-runs the exact same calculation as `/calculate`, from scratch, and commits it — **the client never resends figures**; every number always comes from the DB state (salary structure + leave data) at the moment of this call, so there's nothing computed client-side to trust or tamper with. A row for an `(employee, pay_period)` that has **no existing slip, or one that's `VOIDED`**, is committed — the previous values (if any) are archived into `salary_slip_revisions` first (append-only, same philosophy as `audit_logs`), not discarded, and a `VOIDED` slip's `status` resets back to `ACTIVE` (clearing `voided_by`/`voided_at`/`void_reason`) — a fresh confirm supersedes an earlier void, the same way it already supersedes the earlier figures.

An `(employee, pay_period)` that already has an **`ACTIVE`** slip is **not** overwritten — that row comes back in `skipped` with `status: "already_generated"` and `skipReason: "Already received a payslip for this period — void the existing slip first to re-run"` instead. Re-running an already-generated period is a deliberate correction, not something a repeat click should do silently; call `POST /:id/void` on the existing slip first, then confirm again.

`skipped` in this response carries **every** non-`ok` row, whatever its reason (already received, nothing payable, no structure, unverified profile) — so nothing a run declined to commit is left unexplained.

Same `payPeriod`-not-fully-ended rejection, and the same joining-date skip/pro-ration rules, as `/calculate` above.

**Auth**: `HR_ADMIN` only.

**Body**: `{ "payPeriod": "YYYY-MM, required", "role": "EMPLOYEE | MANAGER | HR_ADMIN, optional", "profileStatus": "INCOMPLETE | SUBMITTED | VERIFIED, optional" }` — same filter shape as `/calculate`.

**Response** `200` — `{ "committed": [/* row shape above */], "skipped": [/* same skip shape as /calculate, plus the "already generated" reason above */] }`.

**Side effects per committed slip** (never per skipped one): an in-app `SALARY_SLIP_GENERATED` notification, **and an email to that employee with their payslip attached as a PDF** (`payslip-YYYY-MM.pdf`) so it previews inline in Gmail and can be downloaded from there. The email carries a short summary (pay period, payable days, LOP days, net pay); the attached PDF is byte-identical to what `GET /api/salary-slips/:id/pdf` returns.

Emails are sent **after the response**, sequentially, one employee at a time — a 200-employee run means 200 PDF renders and 200 provider calls, which can't be held open inside the request. So a `200` here means *payroll is committed*, not *every email has landed*; per-employee failures are logged (`[payslip-email] period=… sent=… failed=…`) and never affect the committed slips. Controlled by `MAIL_FEATURE_SALARY_SLIP` / `MAIL_ENABLED` — with it off, the notification and `GET /:id/pdf` still work.

**Errors**: `403` caller isn't `HR_ADMIN` · `422` `payPeriod` missing/malformed · `400` `payPeriod` hasn't fully ended yet.

---

### `GET /api/salary-slips/mine`

The caller's own slip history, newest pay period first — always just their own, regardless of role, even for HR (whose separate `GET /api/salary-slips` below covers their team).

**Auth**: any authenticated role.

**Query params** (optional): `payPeriod` (`YYYY-MM`).

**Response** `200` — array of the row shape above.

---

### `GET /api/salary-slips`

The slips visible within the acting HR-tier actor's scope — an `HR_ADMIN`'s own reporting subtree, or `SUPER_ADMIN`'s direct-report `HR_ADMIN`s only (see the Roles section) — never company-wide.

**Paginated:** `limit` (1–100, default **25**) and `offset`, returning `{ "slips": [...], "total": N }`. This list spans every payroll month ever run — 200 employees × 36 months at NFR-7's target — and the `payPeriod` filter is optional, so the default case is all of it. `total` counts the same filters as the page. `GET /salary-slips/mine` is deliberately **not** paginated: that's one person's own ~36 rows.

**Auth**: `HR_ADMIN` or `SUPER_ADMIN`.

**Query params** (all optional): `employeeId` (UUID — outside the caller's scope simply returns no rows, not an error), `payPeriod` (`YYYY-MM`), `role` (`EMPLOYEE | MANAGER | HR_ADMIN` — pre-filters the scope by role before `employeeId`, if given, narrows further).

**Response** `200` — array of the row shape above.

**Errors**: `403` caller isn't HR-tier.

---

### `GET /api/salary-slips/:id`

**Auth**: the employee the slip belongs to, or an HR-tier actor whose scope contains that employee (`HR_ADMIN`'s subtree, or `SUPER_ADMIN`'s direct-report `HR_ADMIN`s) — a manager is never admitted, even their own report's. Mirrors the leave request `/:id` pattern: the check lives inside the service, not a route-level role gate, so it can distinguish "this exists but isn't yours" (`404`, not `403`, so existence isn't leaked).

**Response** `200` — the row shape above.

**Errors**: `401` not logged in · `404` no such slip, or the caller isn't allowed to see it · `422` `:id` isn't a valid UUID.

---

### `GET /api/salary-slips/:id/pdf`

Renders a payslip PDF on demand from the stored slip row (via `pdfkit`) and streams it back — never persisted as a file, generated fresh on every authorized request. Same visibility rule as `GET /:id` (reuses it internally before rendering anything).

**Query params**: `disposition` (optional) — `"inline"` renders the PDF in-app (`DocumentPreviewModal`'s `<iframe>`); anything else, including omitting it, forces a download (the default, and the client's own Download link's behavior). Never interpolated into the header directly — any value other than exactly `"inline"` is treated as absent.

**Response** `200` — `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="payslip-<pay_period>.pdf"` (or `inline; ...` with `?disposition=inline`).

**Errors**: same as `GET /:id`.

---

### `POST /api/salary-slips/:id/void`

Soft-deletes a slip generated by mistake (e.g. the wrong pay period) — sets `status = 'VOIDED'` rather than deleting the row, so there's still a record that it happened and was corrected. HR-only, unlike `GET /:id` — the employee the slip belongs to cannot void their own slip.

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Body**: `{ "reason": "string, optional, max 500 chars" }`

**Response** `200` — the updated row (`status: "VOIDED"`, `voided_by`/`voided_at`/`void_reason` set).

**Errors**: `403` caller isn't `HR_ADMIN` · `404` no such slip, or the employee is outside the caller's subtree · `409` the slip is already `VOIDED`.

---

## Salary Structures (`/api/employees/:id/salary-structure`)

Module 5 v2 (FR-025), added beyond the original brief. The figures HR assigns once per employee (Basic salary, HRA, PF employee/employer contribution, ESIC, Special Allowance, Income Tax) that a payroll run reads from. One current row per employee — HR overwriting it archives the previous values into `salary_structure_revisions` first (same archive-then-upsert pattern as salary slips).

Row shape:
```json
{
  "id": "...", "employee_id": "...",
  "basic_salary": "30000.00", "hra": "12000.00", "pf_employee_contribution": "1800.00", "pf_employer_contribution": "1800.00",
  "esic": "0.00", "special_allowance": "5000.00", "income_tax": "0.00",
  "created_by": "...", "updated_by": null, "created_at": "...", "updated_at": "..."
}
```

### `GET /api/employees/:id/salary-structure`

**Auth**: the employee themself (payroll-readiness transparency), or an `HR_ADMIN` whose subtree contains them.

**Response** `200` — the row shape above, or `null` if none has been assigned yet.

**Errors**: `401` not logged in · `404` caller isn't the subject and isn't HR-with-subtree-access.

---

### `PATCH /api/employees/:id/salary-structure`

Assigns or updates the structure. All seven figures are sent together (not a partial update — a structure is meant to be the complete picture a payroll run reads).

**Auth**: `HR_ADMIN` only, and only within their own reporting subtree.

**Body**
```json
{ "basicSalary": "number, required, >= 0", "hra": "number, optional, default 0", "pfEmployeeContribution": "number, optional, default 0", "pfEmployerContribution": "number, optional, default 0", "esic": "number, optional, default 0", "specialAllowance": "number, optional, default 0", "incomeTax": "number, optional, default 0" }
```

**Response** `200` — the row shape above.

**Errors**: `403` caller isn't `HR_ADMIN` · `404` employee outside the caller's subtree · `422` validation.

---
