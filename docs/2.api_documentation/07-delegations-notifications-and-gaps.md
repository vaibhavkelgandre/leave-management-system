# Delegations, notifications & known gaps

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Delegations

### Delegations (`/api/delegations`)

Every route below requires `requireAuth`. Nominating a delegate, and listing what you've nominated, are `MANAGER`-only (FR-020) — `manager_id` is always the caller, never client-supplied. `GET /as-delegate` (the delegate's own side) is deliberately **not** role-gated: a manager can nominate a plain `EMPLOYEE` as their delegate, and that employee needs a way to find out they were chosen at all, since nothing else notifies them (no accept/reject step, no email).

#### `POST /api/delegations`

**Auth**: `MANAGER`.

**Body**
```json
{ "delegateId": "string (UUID), required", "startDate": "YYYY-MM-DD, required", "endDate": "YYYY-MM-DD, required, >= startDate" }
```

**Response** `201`
```json
{ "id": "...", "manager_id": "...", "delegate_id": "...", "delegate_first_name": "...", "delegate_last_name": "...", "start_date": "...", "end_date": "...", "created_at": "..." }
```

**Errors**: `400` delegating to yourself, or the delegate doesn't exist/isn't active · `403` caller isn't a `MANAGER` · `409` overlaps a delegation this manager already has · `422` validation.

---

#### `GET /api/delegations/mine`

The caller's own nominated delegations.

**Auth**: `MANAGER`.

**Response** `200` — array of the shape above.

---

#### `GET /api/delegations/as-delegate`

The flip side of `GET /mine`: every delegation where the caller is the **delegate**, most recent start date first. This is how a delegate (who may not be a manager themself) discovers they've been nominated, and how the frontend decides whether to show the dashboard "you're covering X's approvals" tile and reveal the Approvals nav link.

**Auth**: any authenticated role.

**Response** `200`
```json
[{ "id": "...", "manager_id": "...", "manager_first_name": "...", "manager_last_name": "...", "delegate_id": "...", "start_date": "...", "end_date": "...", "created_at": "..." }]
```

---

---

## Notifications

### Notifications (`/api/notifications`)

The in-app notification bell. Every route below requires `requireAuth` only — no role gate, since a notification is inherently self-scoped: every endpoint filters by the authenticated caller (`req.user.id`), never by an id in the request. Created server-side (never via a client-facing write endpoint), almost always right after a triggering action succeeds elsewhere in the API. Creation failures are logged and swallowed at the source — a notification is a non-critical side effect and never fails the real action.

| `type` | Recipient | Fired by |
|---|---|---|
| `LEAVE_REQUEST_SUBMITTED` | Manager (or nearest HR ancestor if none) | `POST /api/leave-requests` |
| `LEAVE_REQUEST_DECIDED` | Employee | `POST /api/leave-requests/:id/approve`\|`/reject`\|`/override` |
| `LEAVE_REQUEST_WITHDRAWN_CANCELLED` | Manager (or nearest HR ancestor if none) | `POST /api/leave-requests/:id/withdraw`\|`/cancel` |
| `LEAVE_REQUEST_OVERDUE` | Manager (or nearest HR ancestor if none) | Hourly sweep — `sweepOverdueLeaveRequests`, for a request still `SUBMITTED` 30+ days after its start date |
| `LEAVE_REQUEST_AWAITING_DECISION` | Employee | The same sweep. Two types for one event because the wording *and* the click destination differ: the manager goes to Approvals to decide it, the employee to My Leave to withdraw it |
| `PROFILE_SUBMITTED` | Nearest HR ancestor | `POST /api/employees/me/profile/submit` |
| `PROFILE_VERIFIED` | Employee | `POST /api/employees/:id/verify` |
| `PROFILE_SENT_BACK` | Employee | `POST /api/employees/:id/send-back` |
| `SALARY_SLIP_GENERATED` | Employee | `POST /api/salary-slips/confirm` |
| `SALARY_SLIP_VOIDED` | Employee | `POST /api/salary-slips/:id/void`, and any employment-date change that voids a slip (`PATCH /api/employees/:id/employment-dates`, `POST /api/employees/:id/exit`). Also emailed — see `MAIL_FEATURE_SALARY_SLIP_VOIDED` |
| `MANAGER_REASSIGNED` | Employee | `PATCH /api/users/:id/manager` |
| `TEAM_MEMBER_ASSIGNED` | Manager (new or newly-assigned) | `PATCH /api/users/:id/manager`, `POST /api/users/invite` |
| `SALARY_STRUCTURE_UPDATED` | Employee | `PATCH /api/employees/:id/salary-structure` |
| `ACCOUNT_STATUS_CHANGED` | Employee | `PATCH /api/users/:id/status` |
| `EMPLOYMENT_DATES_UPDATED` | Employee | `PATCH /api/employees/:id/employment-dates`, `POST /api/employees/:id/exit`. Deliberately quotes **no dates** — same restraint as `SALARY_STRUCTURE_UPDATED`, since a notification list is glanced at casually and often with someone else looking at the screen. The values are on the employee's profile page |
| `DELEGATION_NOMINATED` | Delegate | `POST /api/delegations` |
| `DELEGATION_STARTED` / `DELEGATION_ENDED` | Manager | **Time-based, not event-driven** — `notificationSweepService.js`, run hourly from `server.js`, not from any endpoint |
| `INVITE_ACCEPTED` | The HR admin who sent the invite (`invited_by`) | `POST /api/auth/invitations/accept` |
| `PROFILE_CREATED` | The new employee themself | `POST /api/auth/invitations/accept` |

`entity_type` is one of `LEAVE_REQUEST`, `PROFILE`, `SALARY_SLIP`, `DELEGATION` — `PROFILE` is reused for anything "about a user's own record" beyond just profile verification (manager reassignment, salary structure updates, status changes, invite acceptance), rather than adding a new `entity_type` per field that changed.

#### `GET /api/notifications`

The caller's own notifications, newest first.

**Auth**: any authenticated role.

**Query params**: `unreadOnly` (boolean, default `false`) · `limit` (integer 1–50, default `20`) · `offset` (integer ≥ 0, default `0`).

**Response** `200`
```json
{
  "notifications": [
    {
      "id": "...", "recipient_id": "...", "actor_id": "...",
      "type": "see the table above for the full list",
      "entity_type": "LEAVE_REQUEST | PROFILE | SALARY_SLIP | DELEGATION",
      "entity_id": "...",
      "message": "Priya Sharma submitted a Sick Leave request",
      "is_read": false,
      "read_at": null,
      "created_at": "...", "updated_at": "..."
    }
  ],
  "total": 1
}
```

---

#### `GET /api/notifications/unread-count`

Backs the nav bell's badge.

**Auth**: any authenticated role.

**Response** `200`
```json
{ "count": 3 }
```

---

#### `PATCH /api/notifications/:id/read`

Marks one notification read. Idempotent — marking an already-read notification again just returns it unchanged, rather than erroring.

**Auth**: any authenticated role, and only for a notification belonging to the caller.

**Response** `200` — the updated notification (same shape as the list above).

**Errors**: `404` the id doesn't exist, or belongs to someone else (never a `403` — same "don't reveal existence to a non-owner" policy as everywhere else in this app).

---

#### `PATCH /api/notifications/read-all`

Marks every one of the caller's unread notifications read at once.

**Auth**: any authenticated role.

**Response** `200`
```json
{ "updated": 5 }
```

---

---

## Not yet built (known gaps)

### Not yet built (known gaps)

- Invite resend / revoke.
- No scheduled job for `MONTHLY` accrual leave types — the flag is stored but nothing accrues incrementally yet.
- No delegation-revoke endpoint — only nominate + list exist, matching the brief's scope exactly.
- No seed script for demo data (3-level reporting tree, 2 leave types, holiday calendar, one demo login per role) — every account in the dev DB today was created manually through the real invite/registration flows.
