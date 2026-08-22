# Module 1 — accounts, roles & reporting

> Part of [Test Cases](README.md). If this disagrees with the code, the code wins.

---

## Module 1: Accounts, Roles & Reporting Structure

### ✅ Covered

**Server — `authGoogle.test.js`**
- Logs in an existing active user via a verified Google email and links an `oauth_accounts` row
- Rejects Google login when the verified email has no matching account (403), creating no link row
- Rejects a Google login whose token email isn't `email_verified` (401)

**Server — `authLogin.test.js`**
- Logs in with correct credentials, sets an HttpOnly session cookie
- Rejects a wrong password with the generic "Invalid email or password" message
- Rejects an unknown email with the identical generic message (no user enumeration)
- Rejects login for a non-active (`INVITED`) user

**Server — `authMe.test.js`**
- 401 with no session cookie
- Returns the current user plus their direct manager and nearest HR ancestor
- Resolves the nearest `HR_ADMIN` ancestor even when it isn't the direct manager
- Root HR admin with nobody above gets `manager: null`, `hr: null`
- Session invalidated (401) once the underlying user is set `INACTIVE`

**Server — `authMe.test.js`** (session token integrity)
- Rejects a token signed with the wrong secret (a forged signature, everything else correct)
- Rejects an `alg: none` token — the classic downgrade, where a valid header/payload carries an empty signature
- Rejects a token signed **HS512 with the real secret** — jsonwebtoken's default allowlist for a string secret is the whole HMAC family, so this verified fine until `verifyAuthToken` pinned `algorithms: ["HS256"]`; the test is what proves the pin, and closes the security doc's LOW finding
- Rejects an expired but otherwise perfectly valid token, with the "Session expired" message
- Rejects a malformed cookie value that isn't a JWT at all
- Clears the auth cookie whenever it rejects a bad token, so the browser stops resending it
- Rejects a correctly signed token for a user id that no longer exists (401, not a crash on a null row)
- Rejects a correctly signed token whose subject isn't a user id at all — this one **found a real 500**: a non-UUID subject reached Postgres as an invalid uuid literal (`22P02`, unmapped in `errorHandler`), now shape-checked in `requireAuth`
- Ignores the role claimed in the token payload and uses the database's own role, pinning the "re-fetch, don't trust the payload" property `requireAuth` is built on

**Server — `authRegisterHr.test.js`**
- Creates the singleton `SUPER_ADMIN` (no manager, `profile_status: VERIFIED`), sets a session cookie, never leaks `password_hash`
- Rejects an invalid registration code (401)
- Rejects a second bootstrap once a `SUPER_ADMIN` exists (409); confirms only one ever exists across repeated attempts
- **Concurrency**: two simultaneous bootstraps yield exactly one 201 and one 409, the loser gets the same "already exists" message as the sequential case (not the generic unique-violation wording), and exactly one `SUPER_ADMIN` row exists afterwards — a test the app-level `existsUserWithRole` check cannot pass on its own, so it's really a test of `uq_users_single_super_admin` (migration 038)

**Server — `invitationFlow.test.js`**
- Full happy path: invite → verify → accept (status → `ACTIVE`) → login; re-accepting the same token afterward is rejected (401)
- Rejects an invite from a non-HR caller (403)
- Allows an `HR_ADMIN` invite reporting to another `HR_ADMIN`
- Rejects an `HR_ADMIN` invite with no `managerId` (422)
- Rejects an `HR_ADMIN` invite whose manager is a `MANAGER` (400)
- Rejects a `MANAGER` invite whose manager is another `MANAGER` (400)
- Rejects an `EMPLOYEE` invite whose manager is another `EMPLOYEE` (400)

**Server — `invitationFlow.test.js`** (re-inviting a pending employee)
- A resend issues a working new link, kills the old one (401 on the previous token), answers `200` with `reissued: true` rather than `201`, leaves exactly **one** invitation row, and the new link still accepts into an `ACTIVE` account
- Reissues against the stored row: a changed name, role and manager in the re-invite body are all ignored
- An HR admin resending for someone in their scope they didn't create doesn't become the creator — `invited_by` survives untouched
- An address on an already-active account still 409s, with its own distinct message ("An account with this email already exists")
- A resend from an HR admin in another branch is refused (409) **and leaves the original link alive** — a refused resend must not burn the real one
- An invitation that has lapsed but not yet been swept reissues rather than refusing (the window where the token is dead but the email is still taken)

**Server — `inviteEmail.test.js`** (resend delivery)
- A resend emails the invitee again with a genuinely different link, reports `emailSent: true`, and reuses the first-invite template (the recipient may never have seen the original)

**Server — `inviteEmail.test.js`** (`mailService` mocked, same convention as `passwordReset.test.js`)
- Emails the invitee the same link returned to HR, with the inviter's name, the role and the expiry window
- Stores an expiry matching the configured window (asserted as "hours, not days")
- Clamps an absurd `INVITE_TOKEN_TTL_HOURS` down to the 72-hour maximum, and falls back to the 12-hour default for an unparseable value
- A failed send still creates the account and reports `emailSent: false` with a working fallback link
- A *skipped* send (unconfigured mail provider or the feature flag off — `false` rather than a rejection) also reports `emailSent: false`

**Server — `mailFeatures.test.js` (unit)**
- Every flow defaults to enabled with nothing configured; one flow can be disabled without affecting the others
- Accepts the spellings that turn up in a real `.env` (`false`/`FALSE`/`off`/`0`/`no`/`disabled`, and the truthy equivalents)
- A blank or unrecognized value falls back to the feature default rather than reading as "off"
- `MAIL_ENABLED=false` overrides every per-feature flag; an unknown feature key throws

**Server — `inviteExpiry.test.js`**
- Drops an expired invited user from the list; keeps one still within the validity window
- Never drops a user who already accepted, even with a stale-looking invitation row
- Frees the email for re-invite after expiry
- Rejects verifying/accepting an expired invite token (401, both endpoints)

**Server — `passwordReset.test.js`** (`mailService` mocked, same convention as the Cloudinary mocks — mock the service, never the SDK)
- Identical generic response whether or not the email exists (no enumeration)
- Emails a reset link only for a real, active email; unknown addresses trigger no send
- Full flow: request → confirm → login with new password; reusing the same token afterward fails (401)
- Rejects confirmation with an invalid/unknown token (401)
- **Resend cooldown**: a repeat request inside the window sends no second email and leaves the issued `token_hash` untouched (asserted on the hash, not a row count — the upsert replaces in place), and the already-sent link still works afterwards
- **Reissue after the cooldown** (driven at the repository level with `cooldownSeconds: 0`, since the real window is 15 minutes): replaces the live token in the same row, so the previous link dies
- **Concurrency**: two simultaneous requests for the same real address both return 200 and never 409 — a regression test for the account-enumeration oracle that existed when the write was a non-atomic check-then-insert (the partial unique index raised 23505, which `errorHandler.js` maps to 409, while an unknown address always got 200)
- **Delivery failure is invisible**: when the send rejects, the response is byte-identical to the unknown-email case, and the rejection is consumed rather than surfacing as an unhandled rejection

**Server — `userRoutes.test.js`**
- 401 on `GET /api/users` with no session
- Returns a success-enveloped user array
- `PATCH /users/me/profile` updates only self-editable fields, normalizes PAN to uppercase
- Silently ignores smuggled privileged fields (`role`, `managerId`, `status`, `email`)
- `POST /users/me/password` rejects a wrong current password (401); accepts a correct one and the new password subsequently authenticates

**Server — `userStatus.test.js`** (creator-or-scope rule)
- An HR admin may change the status of an account with **no recorded creator** that sits inside their own subtree (the case the creator-only rule used to make unmanageable)
- Still 403 for an account — with or without a creator — in a *different* branch

**Server — `userStatus.test.js`**
- Creating HR can deactivate/reactivate an employee they created; deactivation invalidates the employee's session immediately
- Rejects a non-creating HR admin from changing status (403)
- Rejects any HR admin from changing status on an account with no recorded creator (403)
- Rejects HR deactivating themself (400)
- Rejects a non-HR (`MANAGER`) caller (403)

**Server — `usersScope.test.js`**
- `GET /api/users` scopes by role (HR: whole tree, manager: reports, employee: self); never leaks `password_hash`
- PAN/Aadhar/passport/bank fields shown in full to HR and the employee themself, masked (null) for the employee's manager; non-sensitive fields stay visible to the manager

**Server — `hrReportingHierarchy.test.js`**
- Creating HR admin can change who their created HR admin reports to
- Rejects a non-creating HR admin from doing so (403)
- Rejects reassigning a root HR admin's manager — nobody created them (403)
- Detects and rejects a cycle within an HR chain (409)
- Invited HR admin's `manager_id` is already the inviter right after acceptance

**Server — `reportingCycle.test.js`**
- Rejects self-as-own-manager (400)
- Allows valid employee re-parenting (200)
- Rejects `MANAGER` as an HR admin's manager (400)
- Rejects `MANAGER` as another manager's manager (400)
- Rejects `EMPLOYEE` as another employee's manager (400)
- Rejects a non-creating HR admin reassigning an employee's manager (403)

**Client — `LoginForm.test.jsx`, `ForgotPasswordPage.test.jsx`, `ResetPasswordPage.test.jsx`, `AuthProvider.test.jsx`, `authService.test.js`, `App.test.jsx`, `routing/PublicOnlyRoute.test.jsx`, `routing/RequireAuth.test.jsx`, `routing/RequireRole.test.jsx`**
- Full field validation, submit wiring, server-error display, and Google sign-in on the login form
- No-enumeration confirmation messaging on forgot-password (success and failure look identical), plus the two affordances that let a user catch their own typo without the page revealing whether the address is registered: the submitted address is echoed back, and "Try a different email" returns to the form with it preserved for editing
- Password length/match validation, token-from-URL wiring, and error display on reset-password
- Session bootstrap (`getMe`), 401-as-logged-out (not error), network-error surfacing, login/logout state transitions
- `normalizeUser`: passthrough of all fields, `role` normalization from a nested object
- Route guarding: public home vs. dashboard redirect, loading state, role-gated routes (including the `alsoAllowIfActiveDelegate` exception for a delegate employee)
- NavBar: All Employees renders for `SUPER_ADMIN` only (not `HR_ADMIN`), no Apply Leave link for any role, and My Leave stays highlighted on the nested apply-leave route
- TeamPage: HR sees change-manager/activate icons for a teammate a colleague created and for an account with no recorded creator; a plain `MANAGER` sees neither; HR gets an Add Employee action and a manager doesn't
- ApprovalsPage: HR gets one team-scoped actionable list and **no tabs**; `SUPER_ADMIN` gets the read-only All Requests tab and can switch back
- AddEmployeePage: back link goes to My Team for HR, All Employees for `SUPER_ADMIN`

**Client — `InviteEmployeeForm.test.jsx`**
- Role-appropriate reporting-line field (Manager / Reporting HR admin / Reports-to)
- Offers `SUPER_ADMIN` (never a `MANAGER`) as a reporting option for a new HR admin, defaults to the inviter ("You")
- Clears an invalid reporting-line pick when role changes
- Submits with the right `managerId`; shows the invite link with copy-to-clipboard
- Confirms the invite was emailed (`emailSent: true`) while keeping the link as a copyable fallback, and warns instead when the server couldn't build a link at all
- Client-side email format check beyond native browser validation
- Surfaces field-level and generic server errors without clearing the form

**Client — `EmployeesPage.test.jsx`, `TeamPage.test.jsx`, `employeeGroups.test.js`**
- Loading/error states; invite-in-a-modal; no manager/status controls on the company-wide directory
- "You" badge on the logged-in user's own row; correct leadership/team/unassigned bucketing including `SUPER_ADMIN` in leadership
- My Team: direct vs. extended team split, profile-status tags, manager-change and activate/deactivate wired up
- Creator-only edit restrictions mirrored client-side for both manager-change and activate/deactivate, including the "no recorded creator" and "root HR admin" cases

### 🔴🟡 Gaps

> ✅ **Two 🔴 gaps previously listed here are closed** (see the covered sections above). Both are recorded in
> `.claude/rules/02-backend-conventions.md` because both turned out to be more than test debt: the `SUPER_ADMIN`
> singleton was only ever enforced in the application (a check-then-insert), now backed by a partial unique index in
> migration `038`; and the token-integrity tests found a correctly-signed non-UUID subject answering `500` instead of
> `401`, now guarded in `requireAuth`.

- 🔴 **No IP-level rate-limiting / brute-force protection test on login** — and as far as the codebase shows, no such middleware exists at all. Worth confirming whether this is in scope; if not, it's a product gap, not just a test gap. Password reset now has a *per-account* cooldown (covered above), but that's keyed on `user_id` and doesn't stop an attacker cycling many known addresses — so the IP-level gap remains for that endpoint too.
- ✅ **Covered (was 🟡): re-inviting an email whose invite is still pending.** The answer to "what's the conflict behavior?" turned out to be "an opaque generic 409, and no way forward for up to 12 hours" — so this was closed by *changing* the behaviour, not just testing it: a re-invite now reissues the link in place. See the two covered sections above, `.claude/rules/03-features-and-access.md` for why each part is shaped the way it is, and §5 of the role matrix for the row-level rule on who may resend.
- 🟡 No test of Google OAuth re-linking an account that's already linked (idempotency).
- 🟡 **Seed script for demo data is not built** (per `.claude/rules.md` — 3-level reporting tree, 2 leave types, holiday calendar, one login per role). Not a test case itself, but it blocks fast, repeatable module-by-module manual testing in any environment — worth prioritizing given today's stated goal.

---
