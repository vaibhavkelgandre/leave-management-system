# Conventions, health & auth

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Conventions

- All routes except `/health` are prefixed with `/api`.
- **Auth**: session is a JWT stored in an `httpOnly` cookie (`lms_token` by default), set automatically by the login/register/accept-invite/reset-password endpoints. There is no bearer token — the browser sends the cookie automatically on same-origin requests with `credentials: include`.
- **Response envelope** — every endpoint below (except `/health`) returns:
  - Success: `{ "success": true, "message": string, "data": <payload or null> }`
  - Error: `{ "success": false, "message": string, "errors": [] }` — `errors` is populated (as `[{ field, message }]`) only for `422` validation failures.
- **Roles**: `EMPLOYEE`, `MANAGER`, `HR_ADMIN`, `SUPER_ADMIN`. `SUPER_ADMIN` is a singleton — exactly one ever exists, created once via `POST /auth/register/hr` — sitting above every `HR_ADMIN` so the account with nobody positioned to approve its leave or verify its profile (the old manager-less root `HR_ADMIN`) has somewhere to go. `SUPER_ADMIN` gets the same authorization treatment as `HR_ADMIN` everywhere below **except**: it can never call `POST /leave-requests/:id/override` (403 — see Leave Requests below), and its HR-scoped *write* actions (verify/send-back a profile, review a document, assign a salary structure, calculate/confirm/void payroll, view team leave requests) are scoped to only its **direct-report `HR_ADMIN`s**, never those `HR_ADMIN`s' own downstream teams — deliberately narrower than `HR_ADMIN`'s own subtree-wide scope, so `SUPER_ADMIN` can't reach into a subordinate `HR_ADMIN`'s team's affairs. Company-wide *read* access is broader for `SUPER_ADMIN` than for `HR_ADMIN`, not merely equal: the user list, the company-wide `GET /leave-requests/all` (which `HR_ADMIN` is refused outright), any individual leave request, and the FR-024 browse/report tools (`GET /leave-requests`, `/report`, `/report/csv`) all cover every employee for `SUPER_ADMIN`, while an `HR_ADMIN` sees only their own branch.
- **Reporting hierarchy rules**, enforced server-side on every endpoint that sets `manager_id`:
  - `HR_ADMIN` can report to another `HR_ADMIN` — specifically whichever HR admin created them (`invited_by`, see `POST /users/invite`), forming a chain — or to the single `SUPER_ADMIN`.
  - `SUPER_ADMIN` can never have a manager — it's the true root of the tree.
  - `MANAGER` can only report to `HR_ADMIN`.
  - `EMPLOYEE` can report to a `MANAGER` or `HR_ADMIN`, never to another `EMPLOYEE`, and never to `SUPER_ADMIN`.
  - Reassigning a manager is rejected if it would create a reporting cycle.
  - Editing who a given `HR_ADMIN` reports to (`PATCH /users/:id/manager`) is further restricted to their creator or an HR-tier actor whose scope contains them — see that endpoint below.
- **SUPER_ADMIN's own leave requests and profile bypass the review workflow entirely** — a leave request it submits is created directly as `APPROVED` (never `SUBMITTED`, no notification, no one to review it), and its profile is `VERIFIED` at account creation. See `POST /leave-requests` and `POST /auth/register/hr` below.

---

## Health

### `GET /health`

Liveness probe. No auth, no DB call.

**Response** `200`
```json
{ "success": true, "message": "ok", "data": { "uptime": 123.45 } }
```

---

## Auth (`/api/auth`)

### `GET /api/auth/bootstrap-status`

Reports whether this deployment still needs its first account, so the signed-out sign-in page can offer the one-time
setup route instead of a form no credential can satisfy. Before it existed, the only way to answer the question was to
POST to `register/hr` and read the `409` — so a fresh deployment's first visitor had nothing to go on but the README.

**Auth**: none (public). The caller has no session and there is nobody to authenticate as.

**Response** `200`
```json
{ "success": true, "message": "Bootstrap status", "data": { "needsBootstrap": true } }
```

`needsBootstrap` is `true` only while no `SUPER_ADMIN` exists. An unmigrated database (no `SUPER_ADMIN` role row) also
answers `true` — there is no super admin either way, and that is the honest answer.

**Why it is safe to leave public**: it exposes exactly one bit, and only ever answers `true` for a database with no
accounts in it. `register/hr` still demands `HR_REGISTRATION_CODE`, so knowing the answer grants nothing that POSTing
and reading the `409` wouldn't. The response body carries nothing else — no count, no administrator identity — and
there is a test pinning that.

**Client surfaces**: `LoginPage` renders a "No administrator account yet" panel with a link to `/register`, and
`BootstrapOnlyRoute` uses the same answer to redirect away from `/register` once an account exists. Both read it
through one hook (`useBootstrapStatus`) deliberately: a login page saying "set one up" beside a `/register` that
bounces back to it is an infinite loop, and a single source is what prevents the two disagreeing.

### `POST /api/auth/register/hr`

Creates the single `SUPER_ADMIN` account, gated by a shared secret — **singleton**: rejects with `409` if one already exists. That `409` is guaranteed, not best-effort: since migration `038` the singleton is enforced by a partial unique index (`uq_users_single_super_admin`), so two simultaneous calls resolve to exactly one `201` and one `409` rather than both succeeding. Formerly created an unlimited number of manager-less root `HR_ADMIN` accounts; repurposed so the true top of the reporting tree is created exactly once. Always creates the account with `manager_id: null`, and `profile_status: 'VERIFIED'` immediately — nobody is positioned to verify SUPER_ADMIN's own profile, so it skips the normal `INCOMPLETE -> SUBMITTED -> VERIFIED` workflow entirely.

**Auth**: none (public), but requires the correct `registrationCode`.

**UI**: `/register` (`RegisterSuperAdminPage`), reached from the sign-in page's own setup panel — see `GET /api/auth/bootstrap-status` above. It was API-only until then, which meant a new deployment could only be set up with curl or Postman.

**Body**
```json
{
  "registrationCode": "string, required — must match HR_REGISTRATION_CODE",
  "firstName": "string, required",
  "lastName": "string, required",
  "email": "string, required, valid email",
  "password": "string, required, min 8 chars"
}
```

**Response** `201` — sets the auth cookie.
```json
{
  "success": true,
  "message": "Super admin registered",
  "data": { "user": { "id": "...", "first_name": "...", "last_name": "...", "email": "...", "role": "SUPER_ADMIN", "manager_id": null, "profile_status": "VERIFIED", "status": "ACTIVE", "created_at": "...", "updated_at": "..." } }
}
```

**Errors**: `401` invalid registration code · `409` a super admin already exists · `422` validation.

---

### `POST /api/auth/login`

Email + password login.

**Auth**: none.

**Body**
```json
{ "email": "string, required, valid email", "password": "string, required" }
```

**Response** `200` — sets the auth cookie. Same generic message for wrong password, unknown email, or a non-`ACTIVE` account (no user enumeration).
```json
{
  "success": true,
  "message": "Logged in",
  "data": { "user": { "id": "...", "first_name": "...", "last_name": "...", "email": "...", "role": "EMPLOYEE", "manager_id": "...", "department_id": null, "status": "ACTIVE", "created_at": "...", "updated_at": "..." } }
}
```

**Errors**: `401 "Invalid email or password"` · `422` validation.

---

### `POST /api/auth/google`

Alternative login for an **existing** active employee via Google Sign-In. Never creates a new account (no self-registration via OAuth) — the Google account's email must already match an active employee.

**Auth**: none.

**Body**
```json
{ "idToken": "string, required — Google ID token (JWT) from the client-side Google Sign-In button" }
```

**Response** `200` — sets the auth cookie, same `data.user` shape as `POST /api/auth/login`.

**Errors**: `401` invalid/unverified Google token · `403 "No account found for this email"` (email doesn't match an active employee) · `422` validation.

---

### `POST /api/auth/logout`

Clears the auth cookie. Always returns `200`, even if the caller wasn't logged in.

**Auth**: none required (safe to call unauthenticated).

**Response** `200`
```json
{ "success": true, "message": "Logged out", "data": null }
```

---

### `GET /api/auth/me`

Returns the current session's full user profile. Role/status are re-read from the database on every call — deactivating a user or changing their role takes effect immediately, with no need to wait for token expiry.

Also includes `manager` and `hr`: a quick summary (`{ id, first_name, last_name, email }`, or `null`) of who's above the caller in the reporting chain — their direct manager, and the nearest `HR_ADMIN` ancestor (the one whose subtree actually contains them, i.e. whoever will end up verifying their profile). Resolved by walking `manager_id` upward (`userRepository.findReportingLine`), the reverse direction of `isUserInSubtree`'s downward walk. Only computed for self-view (`viewer.id === id`) — a root `HR_ADMIN` with nobody above them gets `null` for both. Powers the "Reports to / HR" line on the dashboard and the read-only Manager/HR fields on the profile page.

**Auth**: required (cookie).

**Response** `200`
```json
{
  "success": true,
  "message": "Current user",
  "data": {
    "user": {
      "id": "...", "first_name": "...", "last_name": "...", "email": "...", "role": "MANAGER",
      "manager_id": "...", "department_id": null, "status": "ACTIVE", "created_at": "...", "updated_at": "...",
      "manager": { "id": "...", "first_name": "...", "last_name": "...", "email": "..." },
      "hr": { "id": "...", "first_name": "...", "last_name": "...", "email": "..." }
    }
  }
}
```

**Errors**: `401` no/invalid/expired cookie, or the account is no longer `ACTIVE`.

---

### `POST /api/auth/invitations/verify`

Confirms an invite token (from an invite link `CLIENT_BASE_URL/invite/:token`) is valid and unexpired, and returns just enough info to render the "set your password" page.

**Auth**: none.

**Body**
```json
{ "token": "string, required — the raw token from the invite link" }
```

**Response** `200`
```json
{ "success": true, "message": "Invitation is valid", "data": { "email": "...", "first_name": "...", "expires_at": "..." } }
```

**Errors**: `401 "This invitation link is invalid or has expired"` · `422` validation.

---

### `POST /api/auth/invitations/accept`

Sets the invited employee's password, activates the account (`INVITED → ACTIVE`), marks the invite single-use, and logs the user in.

**Auth**: none.

**Body**
```json
{ "token": "string, required", "password": "string, required, min 8 chars" }
```

**Response** `200` — sets the auth cookie.
```json
{ "success": true, "message": "Invitation accepted", "data": { "user": { "id": "...", "email": "...", "status": "ACTIVE" } } }
```

**Errors**: `401` invalid/expired/already-used token · `422` validation.

---

### `POST /api/auth/password-reset/request`

Starts a password reset. **Always returns the same generic response whether or not the email exists** — this endpoint must never be usable to discover which emails are registered. If the account exists and is `ACTIVE`, a reset link (`CLIENT_BASE_URL/reset-password/:token`, valid 1 hour, single-use) is generated and **emailed to the account's address** (`mailService.js` → `config/mailer.js`). When the mail provider isn't configured the link is logged to the server console instead, so local development works without credentials.

Three properties of this endpoint exist specifically to preserve the "same generic response" guarantee, and none should be changed without understanding why:

- **The send is fire-and-forget, not awaited.** An awaited provider call takes noticeably longer for a real account than an unknown address, which returns in milliseconds, which is a measurable account-enumeration oracle from a single request pair.
- **A delivery failure never becomes a 5xx.** A mail outage would otherwise return 500 for real accounts and 200 for unknown ones — the same leak by another route.
- **A repeat request within 15 minutes is silently ignored** (`RESEND_COOLDOWN_SECONDS`), enforced atomically in SQL. This stops the endpoint being used to mail-bomb an inbox or burn the daily sending quota. The previously-issued link stays valid, and the throttled response is byte-identical to a normal one.

**Auth**: none.

**Body**
```json
{ "email": "string, required, valid email" }
```

**Response** `200` (always, regardless of outcome)
```json
{ "success": true, "message": "If that email exists, a password reset link has been sent", "data": null }
```

---

### `POST /api/auth/password-reset/confirm`

Sets a new password using a reset token.

**Auth**: none.

**Body**
```json
{ "token": "string, required", "password": "string, required, min 8 chars" }
```

**Response** `200`
```json
{ "success": true, "message": "Password reset successfully", "data": null }
```

**Errors**: `401 "This password reset link is invalid or has expired"` (invalid, expired, or already-used token) · `422` validation.

---
