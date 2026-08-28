# Delegations, notifications & known gaps

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Delegations

### Delegations (`/api/delegations`)

Every route below requires `requireAuth`. Nominating a delegate, **editing** one, and listing what you've nominated, are `MANAGER`-only (FR-020) — `manager_id` is always the caller, never client-supplied, and an edit is refused for a delegation the caller didn't nominate. `GET /as-delegate` (the delegate's own side) is deliberately **not** role-gated: a manager can nominate a plain `EMPLOYEE` as their delegate, and that employee needs a way to find out they were chosen at all, since nothing else notifies them (no accept/reject step, no email).

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

**Errors**: `400` delegating to yourself, the delegate doesn't exist/isn't active, or the window has **already ended** · `403` caller isn't a `MANAGER` · `409` overlaps a delegation this manager already has, **or** the candidate delegate holds a `SUBMITTED`/`APPROVED` leave request overlapping the window · `422` validation.

> **A window whose end date has passed is refused (`400`).** A delegate's authority is resolved live — `findActiveDelegation` only matches `start_date <= today <= end_date` — so a wholly-past window grants nothing today and cannot grant anything later; storing it would just be a row that looks like cover and is not. **Only the end date is checked**: a window that started in the past but hasn't finished is ordinary in-progress cover (a manager who forgot to set it up before leaving is nominating for the days that remain). Same line the edit path draws.

> The delegate-on-leave refusal names the colliding dates and whether that leave is approved or still pending, since the manager's next attempt would otherwise be a guess. Both statuses block: a pending request is usually this manager's own decision to make, and nominating over it would leave them holding two mutually exclusive commitments for the same days. A `REJECTED`/`WITHDRAWN`/`CANCELLED` request never blocks.

---

#### `PATCH /api/delegations/:id`

Change who is covering, or when. Exists because the chosen delegate can stop being available after the fact: a delegate may book leave over a window that has **not started yet**, which is deliberately allowed and only notifies both sides (see `DELEGATION_LEAVE_CONFLICT` below) — before this endpoint the manager had nowhere to go with that notification, since there is still no revoke endpoint.

**Auth**: `MANAGER`, and only the manager who nominated it. Someone else's delegation answers `404`, not `403` — a stranger has no more legitimate reason to learn one exists than to learn the id was simply wrong (NFR-5).

**Body** — every field optional, **at least one required**. Anything omitted keeps its stored value.
```json
{ "delegateId": "string (UUID)", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }
```

**Response** `200` — the updated delegation, same shape as `POST`.

**Errors**: `400` reassigning to yourself, a delegate that doesn't exist/isn't active, a **merged** window that has already ended (distinct from the `409` below — that is about the stored row being frozen, this is about the *result* granting nothing), or a **merged** range that inverts (only one date sent, the other coming from the stored row — the validator can't see both, so the service compares them) · `403` caller isn't a `MANAGER` · `404` no such delegation, or it belongs to another manager · `409` the window has **already ended**, it overlaps another delegation of this manager's, or the new delegate holds `SUBMITTED`/`APPROVED` leave inside it · `422` a body that changes nothing, or a malformed date.

> **A window that has already ended cannot be edited.** That coverage already happened and `audit_logs` records who acted for whom during it, append-only — rewriting the nomination afterwards would contradict that trail while changing nothing about who may approve anything now. A window **in progress** stays editable on purpose: a delegate who becomes unavailable on day two of a ten-day window is exactly when a manager most needs to reassign the remaining days.

> Every guard a fresh nomination goes through is re-run against the **merged** result, not the patch alone (`assertDelegationIsAllowed`, shared by both paths) — otherwise an edit would be a route into a state a create refuses. The overlap check excludes the row being edited, since a delegation always overlaps itself.

> The row is **updated in place**, never superseded by a second one, so "who is covering" stays a single answer and `GET /mine` does not grow a row per correction.

---

#### `GET /api/delegations/mine`

The caller's own nominated delegations.

**Auth**: `MANAGER`.

**Response** `200` — array of the shape above, each row additionally carrying `conflict_leave_start_date`, `conflict_leave_end_date` and `conflict_leave_status` (all `null` when there is no clash).

> **Those three columns are the manager's standing view of the `DELEGATION_LEAVE_CONFLICT` case.** A delegate may book leave inside a window that hasn't started, which is deliberately allowed and notifies both sides — but a notification is read once and then gone, while this page is what the manager returns to. Without them a compromised nomination looks fine.
>
> They can only ever describe leave booked **after** the nomination, because nominating over existing leave is refused outright on both `POST` and `PATCH`. `SUBMITTED` and `APPROVED` only, the same two statuses that guard blocks on — so the list and the edit endpoint can never disagree about whether a clash exists. Resolved in the list query itself via a `LEFT JOIN LATERAL … LIMIT 1`, not one query per delegation: `/mine` returns every delegation a manager has ever created, so per-row lookups would be an N+1 growing with their history.

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
| `LEAVE_DAYS_ADJUSTED` | Employee | `POST`/`PATCH`/`DELETE /api/holidays` — when a holiday change recounts one of their live requests. Quotes **both** figures, unlike the pay-affecting notifications: the point is that a number they were told has changed, and leave day counts aren't sensitive the way a salary is |
| `EMPLOYMENT_DATES_UPDATED` | Employee | `PATCH /api/employees/:id/employment-dates`, `POST /api/employees/:id/exit`. Deliberately quotes **no dates** — same restraint as `SALARY_STRUCTURE_UPDATED`, since a notification list is glanced at casually and often with someone else looking at the screen. The values are on the employee's profile page |
| `DELEGATION_NOMINATED` | Delegate | `POST /api/delegations`, and `PATCH /api/delegations/:id` when the delegate is swapped — from the incoming delegate's side that is an ordinary nomination, so it needs no separate type |
| `DELEGATION_REVOKED` | The **outgoing** delegate | `PATCH /api/delegations/:id`, when the delegate changes. Nothing else would ever tell them: their dashboard tile would simply stop appearing. Deliberately does **not** name their replacement — they are no longer party to the delegation, and nothing they need to do depends on who took over (same restraint as `SALARY_STRUCTURE_UPDATED`) |
| `DELEGATION_UPDATED` | Delegate | `PATCH /api/delegations/:id`, when the delegate is unchanged and only the **dates** moved. Quotes the new dates, unlike the revoke message — they are the whole content of the news, and the recipient has to act on them |
| `DELEGATION_STARTED` / `DELEGATION_ENDED` | Manager | **Time-based, not event-driven** — `notificationSweepService.js`, run hourly from `server.js`, not from any endpoint |
| `DELEGATION_LEAVE_CONFLICT` | **Both** the delegate and the nominating manager, with different wording | `POST /api/leave-requests`, when the leave overlaps a delegation window that has **not started yet** (an already-started one is refused instead) |
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
