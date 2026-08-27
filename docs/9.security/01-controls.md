# Controls — authentication, sessions, authorization & data

> Part of [Security](README.md). If this disagrees with the code, the code wins.

---

## Authentication & sessions

### Three login paths, one outcome

Password login, Google sign-in, and invite-acceptance all converge on the same thing: an **`httpOnly` cookie
containing a signed JWT**, and a response body carrying the user — never the token.

| | |
|---|---|
| Algorithm | HS256, symmetric, `JWT_SECRET` |
| Payload | `{ sub, role }` — `{ sub }` only for the invite-accept flow |
| Lifetime | `JWT_EXPIRES_IN`, default `8h` |
| Cookie | `httpOnly`, name from `AUTH_COOKIE_NAME` (default `lms_token`) |

**`httpOnly` is the point**: page JavaScript cannot read the cookie, so an XSS bug can't exfiltrate the session the way
it could a token in `localStorage`. The cost is that the frontend can't inspect its own auth state, which is why
`GET /auth/me` exists as a session probe.

### The claim in the token is not trusted on its own

`requireAuth` **re-fetches the user on every request** rather than trusting the `role` in the token. Consequences worth
knowing:

- Deactivating a user or changing their role takes effect on their **next request** — no token blacklist, no refresh
  rotation, no waiting for expiry.
- A stolen token stops working the moment the account is deactivated.
- The cost is one query per request, which is the right trade for a stateless design.

`POST /auth/logout` clears the cookie with the same options used to set it — mismatched options and the browser
silently keeps it — and always returns `200`, since there's no server-side session to destroy.

### Cross-site request forgery: protected, but incidentally

The session is a cookie read **only** from `req.cookies` — there is no `Authorization` header path — and in production
it carries `SameSite=None; Secure`, because the frontend and backend are separate `*.onrender.com` subdomains and
`onrender.com` is a public suffix, making them cross-*site*. That is the textbook CSRF setup: the browser attaches the
session to any request any page causes. **There is no CSRF token anywhere in this app.**

What actually stops it today is three properties, none of which was chosen for this purpose. A cross-site page can
only send a request without a CORS preflight if its content type is "simple":

| Content type an attacker can send from another origin | Outcome |
|---|---|
| `application/json` | Not simple → preflight → origin allowlist refuses → the browser never sends it |
| `application/x-www-form-urlencoded` | Arrives with no preflight, but **`express.urlencoded()` is not enabled**, so `req.body` is empty and the Zod validator answers `422` |
| `text/plain` | Same — unparsed, `422` |
| `multipart/form-data` | Arrives with no preflight **and multer parses it**, body fields included |

So virtually every endpoint is safe because of the CORS allowlist and a body parser that isn't installed, not because
of any anti-CSRF design. Two rules follow, and both are load-bearing:

- **Never enable `express.urlencoded()`.** One line would expose every JSON endpoint to plain form CSRF, and nothing
  would fail to warn you.
- **Never widen `CLIENT_ORIGIN` toward a wildcard.** Browsers reject `*` with `credentials: true` outright, but a
  loose allowlist removes the preflight defence that most of the API depends on.

The three routes accepting `multipart/form-data` are where the incidental defences don't reach — see the CSRF finding
in [Findings](02-findings-and-review-checklist.md).

### Passwords

bcrypt, cost 10, via [`utils/password.js`](../../server/src/utils/password.js). bcrypt salts automatically, so identical
passwords produce different hashes.

`verifyPassword` treats a **missing** hash as "never matches" rather than throwing. That's deliberate: OAuth-only users
have no password, and an exception there would leak the distinction between "wrong password" and "this account can't be
logged into that way".

**HR never sets an employee's password.** An invited user sets their own through the invite link, so no plaintext
password ever passes through another human.

### Single-use tokens (invite & password reset)

Both use [`utils/secureToken.js`](../../server/src/utils/secureToken.js):

```js
crypto.randomBytes(32).toString("base64url")   // handed to the user, never stored
crypto.createHash("sha256")                     // stored — this is all the DB has
```

**Only the hash is persisted**, so a database leak alone redeems nothing: the raw value exists only in the email.

| | Invite | Password reset |
|---|---|---|
| TTL | `INVITE_TOKEN_TTL_HOURS`, default **12**, clamped 1–72 | **1 hour**, fixed |
| Single-use | `accepted_at` stamped | `used_at` stamped |
| On expiry | the pending account is **deleted** | the row simply stops matching |

The invite TTL is **clamped in code** so a typo — or an over-enthusiastic environment variable — can't mint a
hundred-day credential. It came down from 24 to 12 hours when delivery moved to email, because a link sitting in an
inbox is a longer-lived exposure than one pasted by HR.

⚠️ **Don't shorten the invite window further without adding a resend endpoint.** The pending account is deleted when
the link lapses and there's no resend, so an over-tight window means HR re-filling the whole form.

### Anti-enumeration in password reset

Three properties of `requestPasswordReset` exist solely so an attacker cannot learn which email addresses are
registered. All three are easy to undo by accident:

1. **The response is identical** whether the account exists, is inactive, or the cooldown blocked it — always `200`,
   always the same body.
2. **The send is fire-and-forget, never awaited.** An awaited provider call takes noticeably longer for a real account
   than the milliseconds an unknown address returns in — a single request pair would measure it. **This is a security
   decision, not a performance one.**
3. **A delivery failure must never become a 5xx.** Otherwise real accounts answer 500 and unknown ones answer 200
   during any mail outage — the same leak by another route. Do not "fix" the `.catch` into a throw.

The **15-minute per-account cooldown** returns silently, byte-identical to a normal response. The obvious objection —
that it lets an attacker lock someone out of resetting — is wrong: every request the attacker triggers delivers a
*working* link to the victim's inbox, so the victim always holds a usable token. It caps abuse at ~96 mails/day/address,
which matters against provider quotas.

⚠️ It's keyed on `user_id`, so it does **not** stop an attacker cycling many known addresses. That needs IP-level
limiting — see [03-findings-and-review-checklist.md](02-findings-and-review-checklist.md).

### The HR registration code

`POST /auth/register/hr` is gated by `HR_REGISTRATION_CODE`, compared with a **timing-safe** comparison so the check
can't be solved character by character.

⚠️ An unset variable compares against `""`, and there is **no attempt throttling in front of it**, which substantially
undermines the timing-safe comparison. Set it, and treat it as a credential.

### Google sign-in

The client obtains an ID token from Google; the server verifies it against `GOOGLE_CLIENT_ID` and matches it to an
existing user. It does not auto-provision accounts — a Google identity with no matching user cannot create one.

The `Cross-Origin-Opener-Policy … window.postMessage` warning in the console comes from Google's own script and is not
ours; see the troubleshooting table in
[`8.deployment_and_operations/04-troubleshooting.md`](../8.deployment_and_operations/03-troubleshooting.md).

---

## Authorization & data protection

### Authorization is server-side. The UI is a courtesy.

Every "hide this control for this role" decision in the frontend — `RequireRole`, `RoleGate`, `hasAnyRole`, `canOverride`
— is **UX only**. The gate is server-side and answers identically whether or not the UI would have shown the control.

This matters because the threat model is an authenticated user editing a request in the network tab. Hiding a button
defends against nothing.

### Out-of-scope reads return `404`, not `403`

A `403` says *"this record exists and you may not have it"*. A `404` says nothing. Since the org chart, who reports to
whom, and who exists at all are themselves sensitive, out-of-scope reads are deliberately indistinguishable from
nonexistent ones.

Applies to per-record endpoints across the app: `GET /users/:id`, `/leave-requests/:id`, `/salary-slips/:id`,
`/notifications/:id`, employee documents. **Preserve this when adding an endpoint** — reaching for `forbidden()` on a
row the caller can't see is the easy mistake.

### Three layers, and why authorization lives in the middle one

| Layer | Enforces |
|---|---|
| Route | coarse role gates — `requireRole("HR_ADMIN", "SUPER_ADMIN")`, `requireUserScope` |
| **Service** | **row-level rules** — is this record in the caller's scope |
| Repository | nothing; it takes an already-authorized scope and queries |

Row-level checks live in services rather than middleware because the same rule is reachable from more than one route,
and because "in scope" isn't a property of the URL — it's a property of the row. `hrScopeService.isInActorsHrScope`,
`isUserInSubtree`, `isManagerOrDelegateOf` and `invited_by` ownership are all service-level.

⚠️ Several services **re-check the role** even though the route already did (`verifyProfile`, `calculatePayroll`). That
duplication is deliberate: a service outlives the route that first called it.

#### Scope differs by role, not just capability

- `MANAGER` — own subtree, via recursive CTE with a depth guard
- `HR_ADMIN` — own reporting subtree, **not** the company
- `SUPER_ADMIN` — company-wide reads; its *HR scope* is its direct-report HR admins

`docs/7.role_permissions_matrix.md` is authoritative and updated whenever access changes — that's a standing rule, and
a permission change absent from the matrix is an unfinished change.

### Sensitive data

| Data | Where | Handling |
|---|---|---|
| Passwords | `users.password_hash` | bcrypt, never returned by any endpoint |
| Invite/reset tokens | `invitations`, `password_resets` | SHA-256 only; raw value exists solely in the email |
| Government IDs (PAN, Aadhaar) | `users` | masked in profile responses |
| Bank details | `users` | masked in profile responses |
| Salary structures & payslips | `salary_structures`, `salary_slips` | scoped to self or HR-tier in scope |
| Identity documents | Cloudinary | private, proxied, never a public URL |

#### Omitting beats masking

`GET /users/options` — the endpoint every dropdown uses — selects **five columns**. The government-ID and bank columns
aren't masked there, they're **never queried**. A projection that can't leak is stronger than one that remembers to
mask, and it cut ~90% of the payload as a side effect.

⚠️ **When adding a list endpoint, ask whether it needs the sensitive columns at all** before reaching for masking.

### Employee documents

- **Type-checked by content, not by name or client MIME type.** `detectFileType(file.buffer)` inspects the actual
  bytes ([`utils/fileType.js`](../../server/src/utils/fileType.js)); a `.pdf` extension on a script proves nothing.
- **5 MB cap**, enforced by multer before anything reaches memory.
- **Memory storage only** — buffers go straight to Cloudinary and are never written to disk, so there's no temp file to
  leak or traverse.
- **Never publicly linkable.** Assets are `resource_type: "raw"`; serving them goes through
  `GET /employees/documents/:documentId/file`, which authorizes from the row and streams the bytes with our own
  `Content-Type` and `Content-Disposition`.

That last point is why the preview endpoint exists at all, and it's a security property as much as a UX one: a signed
Cloudinary URL handed to the browser would be a bearer token for that document, shareable and un-revocable.

⚠️ **Known limit**: magic-byte sniffing reads only the leading bytes, so a polyglot file — valid PDF header, other
content after it — passes. Neutralised in practice by private storage plus a server-controlled `Content-Type`, and
named as an inherent limit of signature detection rather than a bug.

### Transport & secrets

- **CORS with an origin allowlist and `credentials: true`.** A wildcard origin cannot be used with credentials, so the
  allowlist is load-bearing rather than decorative. `CLIENT_ORIGIN` unset defaults to localhost, which breaks every
  browser request in production while curl still works — a confusing failure worth recognising.
- **`.env` is never committed**; `.env.example` documents every variable with no values.
- ⚠️ **Anything in a frontend build is public.** Vite inlines `VITE_`-prefixed variables into the bundle. No secret may
  ever go there.
- ⚠️ **The unconfigured-mail fallback logs whole message bodies, including live invite and reset links.** Fine locally;
  a credential leak into log aggregation in any deployed environment. `isMailConfigured()` must be true anywhere real.

### Audit trail

Every leave decision is recorded with actor and timestamp in `audit_logs`, and payslip voids record a reason. For the
in-scope adversary this is detection rather than prevention — and for the out-of-scope adversary (a trusted HR admin
acting badly) it's the *only* control, which is why it must not be treated as optional.
