# Findings & review checklist

> Part of [Security](README.md). Every finding below was confirmed by reading the code, not assumed from the stack.

---

### Implemented protections (confirmed by direct code inspection)

- **CORS**: env-driven origin allowlist (`CLIENT_ORIGIN`, comma-split), never a wildcard, correctly paired with `credentials: true` (`server/src/app.js`).
- **SQL injection**: PASS across all 13 repository files inspected — every dynamic-WHERE builder (`findLeaveRequestsFiltered`, `findLeaveTakenReport`) interpolates only positional placeholder *numbers* (`$1`, `$2`, ...), never values; every value travels through the parameterized `params` array.
- **Cookies**: `httpOnly` always; `secure`+`SameSite=None` in production (required for the cross-subdomain Render deployment), `SameSite=Lax`+non-secure in dev (matches the same-origin local setup) — `server/src/utils/cookies.js`.
- **JWT**: secret from `process.env.JWT_SECRET`, 8h default expiry, and — the more important property — `requireAuth` never trusts the token's `role` claim, re-fetching it live from the DB every request. All of this is now pinned by tests rather than asserted here: `authMe.test.js` rejects a forged signature, an `alg: none` downgrade, an expired token, a malformed cookie, a subject for a user that no longer exists, and a subject that isn't a user id at all — and confirms a swapped `role` claim changes nothing. Writing those found one real defect (below).
- **Non-UUID token subject** no longer reaches the database. `findAuthContextById` interpolates the subject into `WHERE u.id = $1`, so a correctly-signed token carrying a non-UUID subject raised Postgres `22P02` and surfaced as a **500 with a logged stack** instead of a 401. `requireAuth` now shape-checks the subject first. Only reachable by a holder of the real `JWT_SECRET`, so this was log hygiene and robustness rather than a live hole — but a 500 is itself a signal, and it's now a 401.
- **JWT algorithm allowlist**: `verifyAuthToken` pins `algorithms: ["HS256"]`. This was a LOW finding here and turned out to be slightly more than defence-in-depth — jsonwebtoken's default for a *string* secret is the whole HMAC family, so a token signed **HS384 or HS512 with our secret was accepted**, i.e. a valid session signed with an algorithm this app never issues. Confirmed by direct experiment before fixing, and pinned by a test (`authMe.test.js` rejects an HS512 token carrying the real secret). Never exploitable without the secret, so the severity was right; the allowlist is what makes "we accept exactly what we issue" true rather than incidental. Pinned on verify only, since verify is where an attacker-supplied header gets a vote.
- **XSS**: no `dangerouslySetInnerHTML` anywhere in `client/src`; no backend endpoint reflects raw user input into an HTML response (the one CSV-generating endpoint sets `Content-Type: text/csv`, not HTML).
- **File upload**: multer memory storage (never touches disk) + 5MB limit + magic-byte content sniffing (`fileType.js`) restricted to PDF/JPEG/PNG — never trusts the client-supplied extension or `Content-Type`. Uploaded documents are stored as private Cloudinary `authenticated` assets, retrievable only via a 5-minute signed URL minted fresh per call, gated behind this app's own authorization check, and served back with a server-controlled `Content-Type` + forced `Content-Disposition: attachment`.
- **Secrets**: no production-path secret logging found; `.env`/`.env.test`/`.env.*.local` are gitignored.
- **Filename header injection**: the document-download endpoint strips `"`/`\r`/`\n` from the user-supplied original filename before interpolating it into the `Content-Disposition` header.
- **Timing-safe comparison**: the HR-registration shared secret is compared via `crypto.timingSafeEqual`, not `===`, specifically to avoid leaking match-length information via response timing.

- **IP-level rate limiting** on every endpoint reachable without a session (`server/src/middlewares/rateLimiter.js`, `express-rate-limit`), closing what was this document's only HIGH finding. `POST /auth/login` + `POST /auth/google` share 20 attempts per 15 minutes; `POST /auth/register/hr` gets 5 per hour; `POST /auth/password-reset/request` 10 per hour; the single-use-token routes (invitation verify/accept, password-reset confirm) 30 per hour. Over the limit is a `429` in the standard error envelope. Five properties are deliberate:
  - **Login counts failures only** (`skipSuccessfulRequests`). The key is an IP, and an office behind one NAT is one IP — counting successes would throttle a company signing in. A brute-force attempt is all failures, so the ceiling only binds on the attack.
  - **Password reset counts successes too**, because there a *success* is what sends an email — the abuse being capped is mail-quota burn across many addresses, which `issuePasswordReset`'s per-account 15-minute cooldown cannot see (it is keyed on `user_id`). The limit is on the IP, never the address, so it does not reintroduce the account-enumeration oracle the rest of that endpoint is built to avoid.
  - **Not applied globally.** The authenticated API is left unlimited: the client polls the notification bell and the approvals badge every 30s each, so a shared-IP limit over everything would throttle ordinary use. The pre-auth routes are the ones where a high rate is never legitimate.
  - **Off under `NODE_ENV=test` by default** (`RATE_LIMIT_ENABLED` is read per request, not captured at import), because the integration suite makes hundreds of logins from one loopback address. `rateLimiting.test.js` switches it on and resets the counters, so the limits themselves are still covered.
  - **Known limit, accepted:** the store is in-memory, so counts are per process and reset on deploy. Correct for the current single-instance Render deployment; a shared store (Redis) is what a second instance would need.

### Potential weaknesses

| Severity | Finding | Detail |
|---|---|---|
| **MEDIUM** | No CSRF protection; three endpoints genuinely reachable | The session is cookie-only (no `Authorization` header path) and `SameSite=None; Secure` in production, and there is no CSRF token. What protects the API today is incidental — the CORS allowlist forces a preflight on `application/json`, and `express.urlencoded()` is not enabled, so form-encoded bodies arrive unparsed and 422. **`multipart/form-data` defeats both**: it is a simple content type, so no preflight, and multer parses it including its non-file fields. That makes `POST /api/leave-requests`, `POST /api/employees/me/documents/:documentType` and `POST /api/employees/me/documents/custom` forgeable from any page a logged-in user visits. Exploiting the leave-request one needs a valid `leaveTypeId` UUID — unguessable from outside, but readable by **any authenticated employee**, which for a leave system is the realistic attacker. Not HIGH because only three routes are reachable and the impact is bounded (submitting leave as yourself, uploading a document to your own profile); not LOW because the defences are accidental, so a single line elsewhere — a body parser, a relaxed origin — exposes the whole mutating API at once. `changeMyPassword` is independently immune: it requires the current password. |
| **MEDIUM** | No database transactions | Multi-step writes (e.g. `decideLeaveRequest`'s status update + ledger insert + audit insert) are three independent, non-atomic `pool.query` calls — a crash or connection drop between them leaves the ledger/audit trail out of sync with the request's actual status, with no rollback. |
| **LOW** | Raw invite tokens logged to console outside production | Deliberate dev-mode stand-in for real email delivery, explicitly gated by `NODE_ENV !== "production"` — but any non-production environment's logs (including a shared `staging` env, if one existed) would contain live, usable tokens in plaintext. **Password-reset links are no longer in scope for this finding**: they're emailed now, and only fall back to a console log when the mail provider is unconfigured (never in a configured production environment). The reset path also deliberately keeps the link out of its failure logs, since it's a live credential. |
| **LOW** | Polyglot file risk (theoretical) | Magic-byte sniffing only inspects the first bytes; a file with a valid PDF header followed by other embedded content would pass. Neutralized in practice by private storage + forced download + server-controlled Content-Type, but worth naming as an inherent limit of signature-based detection rather than a bug. |
| **LOW** | No `methods`/`allowedHeaders` restriction on CORS | The origin allowlist is what actually matters given `credentials:true`; the missing method/header restriction is a minor hardening gap, not a live exposure. |

### Recommended improvements


1. ~~Add `express-rate-limit` (or equivalent) to `/api/auth/login`, `/api/auth/password-reset/request`, and `/api/auth/register/hr` at minimum.~~ **Done** — see the rate-limiting entry above; it also covers `/auth/google` and the three single-use-token routes. What remains open is a shared store, which only matters once the API runs on more than one instance.
2. **Close CSRF, in this order** — the first step is small enough that the rest are defence in depth:
   1. **Switch the cookie to `SameSite=Lax`.** `None` exists only because the two Render services are cross-site, but the documented `/api/*` rewrite already makes requests **same-origin** (that is why `VITE_API_URL=/api` works), so the cookie is first-party in the deployed setup. `Lax` blocks cross-site `POST` outright, which closes the multipart hole and every latent one behind it in a single line. **Verify on the deployed pair rather than assuming**, and comment the dependency: if the rewrite is ever removed, `Lax` breaks login.
   2. **Reject state-changing requests with a foreign `Origin`.** ~20 lines of middleware over `POST`/`PATCH`/`DELETE`, reusing the existing `CLIENT_ORIGIN` allowlist. No client change, and it survives someone re-splitting the origins and reverting step 1.
   3. **Require a custom header on the three multipart routes** if you want the narrow fix instead of step 1 — any custom header forces a preflight, which cannot be forged cross-site.
   4. **A double-submit CSRF token** last, not first: a readable cookie, a header on every mutating request, and an Axios interceptor. Only worth the moving parts if the three above can't be relied on.
3. Wrap `decideLeaveRequest`'s three writes (and `submitLeaveRequest`'s insert+ledger+audit sequence) in an explicit Postgres transaction (`BEGIN`/`COMMIT`/`ROLLBACK` via a checked-out client, not the shared pool) so a partial failure can't desynchronize the ledger from the request's actual status.
4. ~~Pin `jwt.verify`'s `algorithms` option explicitly.~~ **Done** — see the JWT algorithm allowlist entry above. Worth noting the finding understated it: the default accepted the entire HMAC family, not merely "no allowlist".
5. ~~If a staging/shared non-production environment is ever introduced, swap the console-logged invite/reset links for a real (even sandboxed) email provider before that environment holds real accounts.~~ **Done for both** (`config/mailer.js` + `services/mailService.js`, now SendGrid over HTTPS): password-reset *and* invite links are emailed. The invite link is still also returned to HR in the response, deliberately — it's the documented fallback when mail is switched off or fails, and the UI promotes it in that case. The console-log path now only happens when the provider is unconfigured, which must never be true in a deployed environment: that fallback logs the whole message body, links included.

---

---

## Review checklist

Run through this before merging anything that touches authentication, authorization, or personal data. It's ordered by
how often each one is actually the thing that's wrong.

### Any new or changed endpoint

- [ ] Is there a **role gate** on the route, and does the service **re-check** it? A service outlives the route that
      first called it.
- [ ] For a per-record endpoint, is the **row-level scope** checked in the service — not inferred from the URL?
- [ ] Does an out-of-scope record return **`404`, not `403`**?
- [ ] Is every SQL value **parameterized**? Dynamic `WHERE` builders may interpolate placeholder *numbers* only, never
      values.
- [ ] Does the response include **sensitive columns it doesn't need**? Prefer a projection that omits them over masking.
- [ ] Is [`docs/7.role_permissions_matrix.md`](../7.role_permissions_matrix.md) updated? A permission change absent from
      the matrix is an unfinished change.
- [ ] If it **accepts `multipart/form-data`**, be aware it is forgeable cross-site: multipart is a simple content type,
      so no CORS preflight stands in front of it and multer parses its non-file fields. Prefer JSON unless a file is
      genuinely being uploaded.
- [ ] Does it change state on a **`GET`**? It must not — a `GET` is trivially forgeable and cacheable. There are none
      today; keep it that way.

### Anything touching files

- [ ] Type detected from **content**, not filename or client MIME type?
- [ ] Size limit enforced **before** the buffer is used?
- [ ] Served through our own endpoint with a server-controlled `Content-Type` — never a public or signed storage URL
      handed to the browser?
- [ ] Any user-supplied string interpolated into a **header** stripped of `"`, `\r`, `\n`?

### Anything touching auth or tokens

- [ ] Tokens generated with `crypto.randomBytes`, stored **only** as a hash?
- [ ] A TTL, and is it **clamped in code** so an env var can't extend it absurdly?
- [ ] Single-use enforced by a stamped column, not by deletion timing?
- [ ] Does any new response **distinguish "account exists" from "it doesn't"** — in body, status, *or* latency?

### Anything touching logs or email

- [ ] Does this log a token, link, password, or full message body? The unconfigured-mail fallback already does; don't
      add a second.
- [ ] Is a new secret **backend-only**? A `VITE_`-prefixed variable is public in the bundle.

### Before deploying

- [ ] **`express.urlencoded()` is still absent from `app.js`.** Its absence is what makes form-encoded CSRF fail on
      every JSON endpoint. Adding it is a one-line, silent regression across the whole mutating API.
- [ ] **`CLIENT_ORIGIN` is still an explicit allowlist**, never a wildcard or a wildcard-ish pattern — the CORS
      preflight it forces is what most of the API's CSRF protection currently rests on.

- [ ] `isMailConfigured()` true in that environment, so the link-logging fallback can't fire.
- [ ] `CLIENT_ORIGIN` set to the real frontend origin — unset silently defaults to localhost.
- [ ] `JWT_SECRET` and `HR_REGISTRATION_CODE` set to real values, not placeholders.
