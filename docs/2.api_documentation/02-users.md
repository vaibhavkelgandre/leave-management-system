# Users

> Part of [API Documentation](README.md). If this disagrees with the code, the code wins.

---

## Users (`/api/users`)

Every route below requires `requireAuth` (a valid session cookie).

### `POST /api/users/invite`

HR invites a new employee/manager/HR admin. Creates a `status: "INVITED"` user with no password, generates a single-use invite token, **emails the invite link to the invitee**, and also returns that link to HR as a fallback.

The link is valid for `INVITE_TOKEN_TTL_HOURS` (default **12**, clamped to **1-72** in code — an unparseable or out-of-range value falls back to the default rather than being trusted). Shortened from 24 hours now that the link is delivered by email and therefore sits in an inbox. If it isn't accepted in that window the pending account is **deleted** — the person disappears from `GET /api/users` and their email becomes available to invite again. See [Invite expiry](#invite-expiry).

**Email delivery** is controlled by `MAIL_FEATURE_EMPLOYEE_INVITE` (and the global `MAIL_ENABLED`) — see `server/src/config/mailFeatures.js`. `emailSent` in the response is `true` only when the message actually reached the mail transport; it is `false` when the mail provider is unconfigured, the flag is off, or the send failed. **A mail failure never fails the request** — the account, its leave balances and its invitation row are all committed before the send, and the returned `inviteLink` still works. `inviteLink` is `null` in the one case where the server couldn't build a URL at all (`CLIENT_BASE_URL` unset).

**Re-inviting the same address is a resend, not an error.** Posting an email that already belongs to a `status: "INVITED"` user issues a **new** token, expires the old one immediately (any copy of the previous link stops working), re-sends the email and answers **`200` with `reissued: true`** — a first invite answers `201` with `reissued: false`. There is no separate resend endpoint; this *is* the resend, because the case it exists for is HR clicking Invite again after the email went to spam or was deleted.

Two things about it are deliberate:

- **The reissue is against the stored row, unchanged.** `firstName`, `lastName`, `role` and `managerId` in the body are **ignored** on this path — the response echoes the values already on record. Editing those is a different intent with its own endpoint (`PATCH /:id/manager`), and rewriting someone's role as a side effect of "send that link again" would be near-impossible to notice. The client says so explicitly in its success message. (The body is still validated, so a resend must still be a well-formed invite request.)
- **`invited_by` never changes.** It's the creator attribution that governs `PATCH /:id/manager` and `PATCH /:id/status`, so a colleague resending a link does not become the person who hired them.

**Who may resend:** the original inviter (`invited_by`), or any HR-tier caller whose own scope already covers that person — the same "creator or in-my-HR-scope" rule as `PATCH /:id/manager`. Note scope is a *downward* subtree walk, so an HR admin **above** the invitee in the chain isn't in scope through that route (only through being the creator). Anyone else gets `409 This email already has a pending invitation`, which reveals no more than the duplicate-email conflict it replaced, and — importantly — leaves the existing link alive.

An **already-lapsed** invitation whose account hasn't been swept yet is also reissued rather than refused: the token is dead but the email is still taken, so before this the address was unusable until `deleteExpiredInvitees` ran.

**Auth**: `HR_ADMIN` only.

**Body**
```json
{
  "firstName": "string, required",
  "lastName": "string, required",
  "email": "string, required, valid email",
  "role": "EMPLOYEE | MANAGER | HR_ADMIN",
  "managerId": "string (UUID), required when role = EMPLOYEE or role = HR_ADMIN; optional when role = MANAGER"
}
```
For `role: "HR_ADMIN"`, `managerId` must be another `HR_ADMIN`'s id — the new HR admin reports to whoever created them (defaults to the inviter themself in the UI, but any other `HR_ADMIN` may be picked instead). This is also what populates `invited_by` on the new user (see `GET /api/users` above), which later governs who may edit that HR admin's own `manager_id` (see `PATCH /:id/manager` below).

**Response** `201` — a new account was created.
```json
{
  "success": true,
  "message": "Employee invited",
  "data": {
    "user": { "id": "...", "first_name": "...", "last_name": "...", "email": "...", "role_id": "...", "manager_id": "...", "status": "INVITED", "created_at": "...", "updated_at": "..." },
    "inviteLink": "http://localhost:5173/invite/<token>",
    "emailSent": true,
    "expiresAt": "2026-08-20T21:30:00.000Z",
    "reissued": false
  }
}
```

**Response** `200` — an existing pending invitation was resent. Same envelope, `message: "Invitation resent"`, `reissued: true`, a fresh `inviteLink`/`expiresAt`, and `user` carrying the **stored** name/role/manager rather than whatever was posted. `200` rather than `201` because nothing was created.

**Errors**: `400` unknown role / manager not found / manager's role doesn't satisfy the hierarchy rule (see Conventions — e.g. `managerId` pointing to a `MANAGER` when `role: "HR_ADMIN"`) · `401` not logged in · `403` caller isn't `HR_ADMIN` · **`409`** `An account with this email already exists` (the address belongs to an `ACTIVE`/`INACTIVE` account — a genuine duplicate, so HR's next step is the employee list, not a resend) **or** `This email already has a pending invitation` (a pending invite the caller isn't entitled to resend) · `422` validation (e.g. missing `managerId` for an `EMPLOYEE` or `HR_ADMIN`).

---

### `GET /api/users`

Lists users, **scoped by the caller's role** — this is the main authorization boundary for viewing people:
- `HR_ADMIN` → every user.
- `MANAGER` → their own full reporting subtree (direct + indirect reports), including themselves.
- `EMPLOYEE` → only themselves (an array of one).

**Auth**: any authenticated role.

**Query params**: none currently (accepted for future use, not yet implemented: filtering/pagination).

**Response** `200`
```json
{
  "success": true,
  "message": "Users retrieved",
  "data": [
    {
      "id": "...", "first_name": "...", "last_name": "...", "email": "...", "role": "EMPLOYEE",
      "manager_id": "...", "department_id": null, "status": "ACTIVE",
      "employee_code": null, "designation": null, "department": null, "phone": null,
      "date_of_birth": null, "highest_education": null,
      "passport_number": null, "passport_expiry_date": null,
      "joining_date": null, "last_working_day": null,
      "blood_group": null, "marital_status": null,
      "current_address": null, "permanent_address": null, "nearest_airport": null,
      "health_problem": null, "health_insurance_status": null,
      "emergency_contact_1_phone": null, "emergency_contact_1_relationship": null,
      "emergency_contact_2_phone": null, "emergency_contact_2_relationship": null,
      "pan_number": null, "aadhar_number": null,
      "bank_account_number": null, "bank_ifsc_code": null, "bank_name": null,
      "profile_status": "INCOMPLETE", "profile_verified_by": null, "profile_verified_at": null,
      "invited_by": "...", "created_at": "...", "updated_at": "..."
    }
  ]
}
```
Never includes `password_hash`. `invited_by` is the id of whoever invited this user (`null` for anyone who registered through a path with no invitation row, e.g. the root `HR_ADMIN`(s) via `POST /auth/register/hr`) — used by the frontend to decide whether the current HR admin may edit an `HR_ADMIN` row's own `manager_id` (see `PATCH /:id/manager` below). `profile_status`/onboarding documents/salary structure are covered under [Employee Onboarding & Profile Verification](#employee-onboarding--profile-verification-apiemployees).

**Module 5 v2**: `pan_number`/`aadhar_number`/`passport_number`/`bank_account_number`/`bank_ifsc_code`/`bank_name` are nulled out (masked) for any viewer who isn't the row's own subject or `HR_ADMIN` — a manager viewing a direct report gets `null` for these six, but sees every other profile field unmasked, same row-level scope as everything else here. Masking is applied in `userService.js` (`maskSensitiveProfileFields`), not the repository, and also applies to `GET /api/users/me/team` and `GET /api/users/:id` below.

Pending accounts whose invite has expired are swept before the list is built, so they never appear here. See [Invite expiry](#invite-expiry).

---

### Invite expiry

An invitation is valid for `INVITE_TOKEN_TTL_HOURS` hours (default **24**). Once that lapses:

- The token stops working — `verify` and `accept` both return `401 "This invitation link is invalid or has expired"`.
- The pending user row is **deleted**. Deleting rather than flagging is deliberate: `users.email` is `UNIQUE`, so a lingering row would permanently block re-inviting that person. Dependent rows (invitation, leave balances, OAuth links, password resets) cascade.

**Only `status = 'INVITED'` accounts are ever removed**, so an accepted account can't be caught by this even if a stale invitation row is left behind.

**How it runs:** there is no scheduler in this project. The sweep happens on any call to `GET /api/users`, in the same self-healing-on-read style as leave balances. A consequence is that an expired invitee lingers in the database until someone next lists users — harmless, since the token is already rejected on its own expiry check.

> ⚠️ If an expired invitee had been set as someone's manager, `users.manager_id` is `ON DELETE SET NULL`, so those reports are left with no manager for HR to reassign.

---

### `GET /api/users/me/team`

Returns the caller's own reporting subtree as a **flat array**, excluding the caller themselves. Empty array (not an error) if the caller has no reports.

**Auth**: any authenticated role (an `EMPLOYEE` with no reports just gets `[]`).

**Response** `200` — same row shape as `GET /api/users`, minus the caller.

---

### `GET /api/users/options`

The picker-sized user list: `[{ id, first_name, last_name, role, status }]` — five columns, not the ~40 `GET /users` returns.

Scoped identically to `GET /users` (company-wide for HR-tier, own subtree for a `MANAGER`, self for an `EMPLOYEE`). Use this for **any dropdown**; `GET /users` is only right for the All Employees roster, which actually displays every field. Four surfaces (invite form, delegation form, HR reports, salary slips) were fetching ~240KB of full profiles per page load to render names in a `<select>`.

No masking is applied because none is needed: the sensitive government-ID and bank columns aren't merely masked here, they're never selected.

**Auth**: any authenticated role.

---

### `GET /api/users/me/team/count`

`{ "count": 12 }` — the size of the caller's own reporting subtree, excluding themselves. Always agrees with `GET /api/users/me/team`'s length; it exists because the dashboard's headcount chip reads one number and that endpoint returns every subtree row with all ~40 public columns (~240KB for 200 people).

**Auth**: any authenticated role. `0` for someone with no reports.

---

### `GET /api/users/:id`

Fetches a single user by id.

**Auth**: the user themselves, an ancestor manager (anyone in their management chain), or `HR_ADMIN`.

**Response** `200` — same row shape as `GET /api/users`.

**Errors**: `401` not logged in · `403` authenticated but out of scope (e.g. a peer employee) · `404` no such user, or malformed id · `422` `:id` isn't a valid UUID.

---

### `PATCH /api/users/:id/manager`

Re-parents a user in the reporting tree.

**Auth**: `HR_ADMIN`/`SUPER_ADMIN` at the route level, and — for every role, not just `HR_ADMIN` targets — the acting admin must **either** be the one who created the target (`invited_by`) **or** have the target inside their own HR scope (an `HR_ADMIN`'s reporting subtree; `SUPER_ADMIN`'s direct-report `HR_ADMIN`s only). Anyone else gets a `403`.

The scope half was added on direct request: creator-alone meant an HR admin had no controls at all for anyone they'd inherited rather than invited — a colleague's joiner, or any account with no invitation record — which read as a missing feature on My Team rather than a permission boundary. This app's authorization is still strict per-team, and that's what the check preserves: a subtree walk never reaches sideways or upward, so a different branch's people stay unreachable and `SUPER_ADMIN` can't be re-parented from below.

**Body**
```json
{ "managerId": "string (UUID) | null" }
```

**Response** `200` — updated user (same shape as `GET /api/users/:id`).

**Errors**: `400` self-assignment, or the chosen manager's role doesn't satisfy the hierarchy rule (e.g. a `MANAGER` picked as an `HR_ADMIN`'s manager) · `403` caller isn't HR-tier at all, **or** is HR-tier but is neither the target's creator nor has them in scope · `404` user not found · `409` would create a reporting cycle · `422` validation.

---

### `PATCH /api/users/:id/status`

Deactivates or reactivates a user. Since `GET /api/auth/me` and `requireAuth` re-check status on every request, deactivating someone ends their active session immediately.

**Auth**: `HR_ADMIN`/`SUPER_ADMIN` at the route level, plus the same creator-**or**-in-my-scope check as `PATCH /:id/manager` above, applied to every role rather than only `HR_ADMIN` targets: the acting admin must either have created `:id` (`invited_by`) or have them inside their own HR scope. An HR admin from a different branch gets a `403`, even though they can otherwise see this user fine via `GET /api/users`. HR cannot deactivate their own account through this endpoint either way.

**Body**
```json
{ "status": "ACTIVE | INACTIVE" }
```

**Response** `200` — updated user (same shape as `GET /api/users/:id`).

**Errors**: `400` caller tried to deactivate themselves · `403` caller isn't `HR_ADMIN` at all, **or** is HR but didn't create this specific account · `404` user not found · `422` validation.

---

### `PATCH /api/users/me/profile`

Module 5 v2 (FR-026): self-service profile edit. Always the caller's own record — no `:id` param, nothing to scope.

**Auth**: any authenticated role.

**Body** (every field optional — a partial update; only the keys present are changed)
```json
{
  "designation": "string, optional",
  "department": "string, optional",
  "phone": "string, optional",
  "dateOfBirth": "YYYY-MM-DD, optional",
  "highestEducation": "string, optional",
  "passportNumber": "string, optional",
  "passportExpiryDate": "YYYY-MM-DD, optional",
  "joiningDate": "YYYY-MM-DD, optional",
  "lastWorkingDay": "YYYY-MM-DD, optional",
  "bloodGroup": "string, optional",
  "maritalStatus": "SINGLE | MARRIED | OTHER, optional",
  "currentAddress": "string, optional",
  "permanentAddress": "string, optional",
  "nearestAirport": "string, optional",
  "healthProblem": "string, optional",
  "healthInsuranceStatus": "string, optional",
  "emergencyContact1Phone": "string, optional",
  "emergencyContact1Relationship": "string, optional",
  "emergencyContact2Phone": "string, optional",
  "emergencyContact2Relationship": "string, optional",
  "panNumber": "string, optional, format ABCDE1234F",
  "aadharNumber": "string, optional, 12 digits",
  "bankAccountNumber": "string, optional",
  "bankIfscCode": "string, optional, format HDFC0001234",
  "bankName": "string, optional"
}
```
`role`/`managerId`/`status`/`email`/`employeeCode`/`profileStatus` are never accepted here — they're stripped by the zod schema even if sent, and `userRepository.updateProfileFields` only ever writes a fixed whitelist of self-editable columns regardless.

**Response** `200` — the caller's updated record (same shape as `GET /api/users/:id`, always unmasked since the caller is always the subject).

**Errors**: `401` not logged in · `422` a field doesn't match its expected format.

---

### `POST /api/users/me/password`

Module 5 (FR-026): authenticated change-password — requires knowing the current password, unlike the forgot-password reset flow (`POST /api/auth/password-reset/request` \| `/confirm`), which doesn't.

**Auth**: any authenticated role.

**Body**
```json
{ "currentPassword": "string, required", "newPassword": "string, required, min 8 characters" }
```

**Response** `200` — `{ "success": true, "message": "Password changed", "data": null }`.

**Errors**: `401` current password doesn't match · `422` `newPassword` shorter than 8 characters.

---
