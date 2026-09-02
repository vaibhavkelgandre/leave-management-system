# Security

> The security posture in one place — what's defended and how, what isn't, and what to check before merging a
> change that touches auth or personal data.
>
> This used to be one section inside the architecture reference, where nobody looking for it would find it.

---

| File | Covers |
|---|---|
| [01-controls.md](01-controls.md) | login paths, sessions, password and token handling, the authorization model, and what counts as sensitive data |
| [02-findings-and-review-checklist.md](02-findings-and-review-checklist.md) | every known weakness with a severity, and the checklist to run before merging |

## Threat model, briefly

The brief's own framing: **assume a reviewer opens the network tab, changes an id in a request, and tries to act
on somebody else's record.** That's the primary adversary — an authenticated, legitimate user reaching outside
their own scope. Everything in [01-controls.md](01-controls.md) follows from taking that seriously.

| Secondary adversary | Defended by |
|---|---|
| Anonymous attacker guessing credentials or a token | bcrypt, 256-bit single-use tokens stored only as hashes, short TTLs, **and now IP-level rate limiting on every pre-auth endpoint** (`middlewares/rateLimiter.js`) |
| Someone reading the database | passwords and tokens are hashed at rest, so a dump alone redeems nothing |
| Someone reading the logs | mostly fine, **except** the unconfigured-mail fallback, which logs live links |
| A page a logged-in user visits, forging a request with their cookie | the CORS origin allowlist and the *absence* of `express.urlencoded()` — **incidental, not designed**. There is no CSRF token, and `multipart/form-data` bypasses both. See the findings |

Explicitly **out of scope**: a malicious HR or super admin. Those roles are trusted by design — they read salary
data and government IDs because that is the job. The audit trail is the control there, not prevention.

## The one finding that matters most

~~**No rate limiting anywhere.**~~ **Closed.** Login, Google login, the HR-registration-code endpoint, password
reset and the single-use-token endpoints are now rate limited by client IP (`server/src/middlewares/rateLimiter.js`,
`express-rate-limit`) — see the table in [02-findings-and-review-checklist.md](02-findings-and-review-checklist.md).
The remaining top finding is CSRF (MEDIUM), where the defences that hold today are incidental rather than designed.
