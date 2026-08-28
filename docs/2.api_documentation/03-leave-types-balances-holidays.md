# Leave types, balances & holidays

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Leave Types (`/api/leave-types`)

Every route below requires `requireAuth`. Leave types are soft-deactivated (`is_active`), never deleted — balances reference them.

### `POST /api/leave-types`

Creates a leave type and immediately backfills a current-year balance (full `annualEntitlement`) for every `ACTIVE` user — existing employees don't have to wait for their next balance read.

**Auth**: `HR_ADMIN` only.

**Body**
```json
{
  "name": "string, required, unique (case-insensitive)",
  "annualEntitlement": "number, required, >= 0, in increments of 0.5",
  "accrualType": "UPFRONT | MONTHLY",
  "allowNegativeBalance": "boolean, optional, default false",
  "requiresDocument": "boolean, optional, default false"
}
```

**Response** `201`
```json
{
  "success": true,
  "message": "Leave type created",
  "data": { "id": "...", "name": "...", "annual_entitlement": "12.0", "accrual_type": "UPFRONT", "allow_negative_balance": false, "requires_document": false, "is_active": true, "created_at": "...", "updated_at": "..." }
}
```

**Errors**: `403` caller isn't `HR_ADMIN` · `409` duplicate name · `422` validation (negative or non-half-day entitlement).

---

### `GET /api/leave-types`

Lists leave types. Inactive types are only ever included for `HR_ADMIN` callers — `includeInactive=true` from any other role is silently ignored.

**Auth**: any authenticated role.

**Query params**: `includeInactive` (boolean, `HR_ADMIN` only).

**Response** `200` — array of leave type rows (same shape as the create response).

---

### `GET /api/leave-types/:id`

Fetches a single leave type by id.

**Auth**: any authenticated role.

**Errors**: `404` not found · `422` `:id` isn't a valid UUID.

---

### `PATCH /api/leave-types/:id`

> ⚖️ **Takes one extra field: `applyToCurrentYear` (boolean, optional, default `false`).** `leave_balances.entitlement` is a snapshot taken when the row is created, so editing a type changes nothing for anyone who already has one. That snapshot is deliberate — retroactively rewriting an entitlement changes what people have already been shown — but the consequence used to be silent: raising Annual Leave from 12 to 15 in June left employees hired in January on 12 all year while anyone hired in July got 15, same type, same year, nobody told.
>
> Opting in rewrites **this year's** existing rows (past years record what people were entitled to then; future years have no rows yet). The response is `{ leaveType, balancesUpdated }`, counting only rows that genuinely changed, and the message repeats it. Applying a *reduction* can take someone's remaining balance negative if they have already used more than the new entitlement — a real consequence of HR's choice, reported rather than silently prevented.

Edits a leave type's definition. Does **not** retroactively change balance rows already materialized for the current year — only affects future backfills.

**Auth**: `HR_ADMIN` only.

**Body**: same shape as `POST /api/leave-types`.

**Errors**: `403` · `404` · `409` duplicate name · `422` validation.

---

### `PATCH /api/leave-types/:id/status`

> 🚫 **Deactivating blocks new requests, not decisions on existing ones.** `POST /leave-requests` refuses an inactive type and new employees get no balance row for it, but a request already `SUBMITTED` can still be approved — it was raised legitimately — and its days still leave the balance. The response is `{ leaveType, pendingRequests }`, counting requests of that type still awaiting a decision, so the type doesn't vanish from the picker while approvals on it keep landing.
>
> A discontinued type also **stays visible in `GET /leave-balances/me` for any employee who has days on it**, flagged `leave_type_active: false`. Filtering purely on `is_active` meant that the moment HR retired a type, everyone who had taken it lost sight of it — the ledger still held the days, but "how many sick days did I take?" became unanswerable from the app. A type the employee never used stays hidden, since a full untouched entitlement would read as leave they could still take.

Activates/deactivates a leave type.

**Auth**: `HR_ADMIN` only.

**Body**
```json
{ "isActive": "boolean, required" }
```

**Errors**: `403` · `404` · `422` validation.

---

## Leave Balances (`/api/leave-balances`)

Every route below requires `requireAuth`. Balances are per calendar year (`year` column) and self-healing on read: the first read for a given user+year ensures a row exists for every active leave type (full `annualEntitlement`, no proration) — this is also what makes a new calendar year "just work" without a year-rollover job. `days_taken`/`days_pending`/`days_remaining` are never stored — they're computed by summing `leave_balance_ledger` at read time (NFR-2), so a leave request's submit/approve/reject/withdraw/cancel/override always keeps them in sync automatically.

### `GET /api/leave-balances/me`

Returns the caller's own balances.

**Auth**: any authenticated role.

**Query params**: `year` (integer, optional, defaults to the current calendar year).

**Response** `200`
```json
{
  "success": true,
  "message": "Balances retrieved",
  "data": [
    { "id": "...", "user_id": "...", "leave_type_id": "...", "leave_type_name": "Annual Leave", "year": 2026, "entitlement": "12.0", "days_taken": "0.0", "days_pending": "0.0", "days_remaining": "12.0", "created_at": "...", "updated_at": "..." }
  ]
}
```

---

### `GET /api/leave-balances/user/:id`

Returns another user's balances.

**Auth**: the user themselves, a manager whose subtree includes the target, or `HR_ADMIN` (same scoping as `GET /api/users/:id`).

**Query params**: `year` (integer, optional).

**Errors**: `403` out of scope · `404` malformed id · `422` `:id`/`year` invalid.

---

## Holidays

> 🗓️ **Every holiday write can recount live leave, and the response says how much.** A holiday is global and feeds the working-day calculation, but `leave_requests.working_days` is computed once at submit and never recomputed — so a holiday declared *after* a request was approved used to leave the employee charged for a day that had become a holiday. Five days deducted for a Mon–Fri leave with a Wednesday holiday added later, permanently one day short; the reverse (a holiday deleted in error) under-charged the same way.
>
> `POST`, `PATCH` and `DELETE` therefore recount every **`SUBMITTED` or `APPROVED`** request overlapping the affected dates, and return `adjusted` — one entry per request whose count changed, with `previousDays` and `newDays`. Other statuses have already released their days, so recounting them would move a balance for a request that no longer affects one.
>
> The balance moves through a new **`HOLIDAY_ADJUSTMENT`** ledger entry rather than an edit — `leave_balance_ledger` exists exactly so a correction is an append (NFR-2: the balance must agree with the history that produced it). `working_days` on the request *is* updated in place, because it is a derived cache; nothing in `audit_logs` is touched, since the leave was still submitted and decided when it was. The employee gets a `LEAVE_DAYS_ADJUSTED` notification quoting both figures.
>
> A **`PATCH` that moves a holiday reconciles the union of its old and new ranges**, because both sets of dates changed meaning. And because payroll sums the stored `working_days` of approved leave, any `ACTIVE` payslip for an affected month is **voided** — re-run payroll for it.
>
> **Response shape:** the mutating endpoints return `{ holiday, adjusted }` (and `{ adjusted }` for `DELETE`) rather than the bare holiday, so the recount is visible rather than silent.

 (`/api/holidays`)

Every route below requires `requireAuth`. Holidays are name + date-range rows (`startDate`, and an optional `endDate` for multi-day holidays like a 5-day Diwali) — unlike leave types, nothing else references them, so they support a real delete.

### `POST /api/holidays`

**Auth**: `HR_ADMIN` only.

**Body**
```json
{ "name": "string, required", "startDate": "string, required, YYYY-MM-DD", "endDate": "string, optional, YYYY-MM-DD — defaults to startDate for a single-day holiday" }
```

**Errors**: `400` the range ends before 1 January of the current year · `403` · `409` date range overlaps an existing holiday · `422` validation (including `endDate` before `startDate`).

> **A holiday can be declared in the recent past, but not in a previous year.** The past is deliberately allowed: governments announce holidays at short notice, an organisation setting this app up in August has to enter January onwards, and the recount every holiday write triggers exists precisely so a holiday declared *after* the leave it affects still corrects those balances. What the year boundary stops is the damaging case — a mistyped year silently recounting a previous year's leave and voiding settled payslips. The **end** date is what's checked, so a range straddling New Year (31 Dec – 1 Jan, entered in January) is still accepted.

---

### `GET /api/holidays`

**Auth**: any authenticated role.

**Query params**: `year` (integer, optional) — matches any holiday whose range overlaps that year at all, so a range spanning a year boundary (e.g. Dec 30–Jan 2) appears under both years.

**Response** `200` — array of `{ id, name, start_date, end_date, created_at, updated_at }`, ordered by start date.

---

### `PATCH /api/holidays/:id`

**Auth**: `HR_ADMIN` only.

**Body**: same shape as `POST /api/holidays`.

**Errors**: `400` the range is being *moved* to end before 1 January of the current year · `403` · `404` · `409` date range overlaps another holiday · `422` validation.

> The year check applies **only when the dates actually change**. This body is the same shape as `POST` (a holiday has no partial edit — the client resends the whole record), so checking unconditionally would make a holiday left over from a previous year impossible to *rename*, which the rule is not about.

---

### `DELETE /api/holidays/:id`

Hard delete.

**Auth**: `HR_ADMIN` only.

**Response** `200` — `{ "success": true, "message": "Holiday deleted", "data": null }`.

**Errors**: `403` · `404`.

---
