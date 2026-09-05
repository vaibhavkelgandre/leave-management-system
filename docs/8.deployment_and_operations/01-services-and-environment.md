# Services, topology & environment variables

> Part of [Deployment & Operations](README.md).

---

## Services & topology

### Two services, deployed independently

| | Frontend | Backend |
|---|---|---|
| Render type | Static Site | Web Service |
| Built from | `client/` | `server/` |
| Build | `npm ci && npm run build` → `dist/` | `npm ci` |
| Start | — (static files) | `npm start` → `node src/server.js` |
| Port | — | Render supplies `PORT`; the app binds it (10000 in practice) |

They deploy **separately**, which is the single most important operational fact about this setup. A push that touches
both means two builds finishing at two different times, and between them the deployed frontend and backend disagree
about what endpoints exist.

⚠️ **Deploy the backend first.** A frontend calling an endpoint the backend doesn't have yet produces `404`/`422`
responses and, downstream, JavaScript errors like `Cannot read properties of undefined (reading 'length')` when a
component destructures a response that never arrived in the expected shape. That looks exactly like a broken feature
and is not one. See [04-troubleshooting.md](03-troubleshooting.md).

### How the frontend reaches the API

The client's HTTP layer resolves its base URL like this ([`apiClient.js`](../../client/src/services/apiClient.js)):

```js
baseURL: import.meta.env.VITE_API_URL || "http://localhost:5001/api"
```

So in production it depends on `VITE_API_URL`, **baked in at build time** — not read at runtime. Two consequences:

- Changing `VITE_API_URL` requires a **rebuild** of the static site, not just a restart. There is no process to
  restart.
- With a `/api/*` rewrite rule configured on the static site forwarding to the backend, `VITE_API_URL` can be the
  relative `/api`, which keeps requests same-origin and avoids CORS entirely.

The backend also sets CORS explicitly, and the response headers show it working:
`Access-Control-Allow-Origin: <frontend origin>` with `Access-Control-Allow-Credentials: true`. **Credentials matter** —
auth is an `httpOnly` cookie, so a wildcard origin would not work even if it were acceptable.

### Cookies across services

Auth is a JWT in an `httpOnly` cookie. If the frontend and backend are on **different** origins, that cookie must be
`SameSite=None; Secure` to be sent at all; same-origin via the rewrite avoids the question. If login appears to succeed
and every subsequent request is `401`, this is the first thing to check — the cookie is being set and then not sent.

### Free-tier hibernation

A free Web Service **sleeps when idle** and takes several seconds to wake. Two visible effects:

- The first request after a quiet period is slow. If a demo's opening click hangs, this is why — see
  [`docs/6.demo_walkthrough/01-setup-and-safety.md`](../6.demo_walkthrough/README.md).
- If the wake itself **fails**, you get `503` with the header `x-render-routing: hibernate-wake-error`. That header is
  the tell: it means the process crashed on startup rather than the service being merely asleep. Read the boot log —
  the cause is at the top of it, not in the request.

A crash at boot is usually a missing dependency or a module that throws at import time. That has happened here once: a
package present in the working tree's `package.json` but never committed, so Render installed without it and a
top-level import killed the process.

### What the backend talks to

| Dependency | Protocol | Notes |
|---|---|---|
| Neon Postgres | TCP, **SSL required** | see [02-database-and-migrations.md](02-database-and-migrations.md) |
| Brevo | HTTPS 443 | HTTPS specifically because outbound SMTP is blocked |
| Cloudinary | HTTPS 443 | document storage; assets are `resource_type: "raw"` |

### What the backend does at boot

Worth knowing, because it's your fastest diagnostic:

```text
Mail provider is not configured — no email will be sent (links are logged instead)   ← only if misconfigured
[mail] on  MAIL_FEATURE_PASSWORD_RESET — Forgot-password link (POST /auth/password-reset/request)
[mail] on  MAIL_FEATURE_EMPLOYEE_INVITE — Invite link with password setup (POST /users/invite)
[mail] on  MAIL_FEATURE_SALARY_SLIP — Payslip PDF after a payroll run (POST /salary-slips/confirm)
Server running on port 10000
```

The `[mail]` banner prints which flows are switched on, because a disabled flow looks exactly like a broken one from
the outside. The absence of the "not configured" warning is how you confirm mail credentials actually reached the
running process.

Note the process does **not** run migrations at boot, and that's deliberate — see
[03-database-and-migrations.md](02-database-and-migrations.md).

---

## Environment variables

### Backend Web Service

#### Required — the app is broken without these

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon's **direct** connection string — the host *without* `-pooler`. Takes precedence over the discrete `DB_*` vars. See [02-database-and-migrations.md](02-database-and-migrations.md) for why the pooled one is wrong here. |
| `DB_SSL` | **`true`.** Managed Postgres refuses unencrypted connections, and [`db.js`](../../server/src/config/db.js) only enables SSL when `NODE_ENV=production` **or** `DB_SSL=true`. |
| `JWT_SECRET` | Signs the auth cookie. Changing it logs everyone out — which is also how you force that if you need to. ⚠️ **Nothing validates it at boot**, so an unset value starts a service that looks completely healthy and then answers `500` on the first *successful* login — see [03-troubleshooting.md](03-troubleshooting.md). |
| `CLIENT_ORIGIN` | The frontend origin, for CORS. Defaults to `http://localhost:5173`, so **an unset value in production breaks every browser request** while curl still works. |
| `CLIENT_BASE_URL` | The frontend URL, used to *build* invite and reset links. Backend variable despite being a frontend URL. No trailing slash. Unset → the server logs `CLIENT_BASE_URL is not set` and sends nothing. |
| `BREVO_API_KEY` | From Brevo's **API Keys** tab, and it must start with `xkeysib-`. The adjacent **SMTP** tab hands out an `xsmtpsib-` key that the HTTP API rejects as `Key not found`. `SENDGRID_API_KEY` is still read as a fallback when this is unset. |
| `MAIL_FROM` | Must be a **verified sender** or every send is a `403`. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Document upload; without them uploads fail. |
| `HR_REGISTRATION_CODE` | Gates the public HR self-registration flow. Compared with a timing-safe comparison; an unset value compares against `""`. |

#### Optional — sensible defaults

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | — | `production` also switches SSL on |
| `PORT` | Render supplies it | |
| `JWT_EXPIRES_IN` | `8h` | |
| `AUTH_COOKIE_NAME` | `lms_token` | |
| `INVITE_TOKEN_TTL_HOURS` | `12`, clamped to 1–72 | a typo can't mint a 100-day credential |
| `MAIL_ENABLED` | on | global kill switch for all outbound mail |
| `MAIL_FEATURE_PASSWORD_RESET` | on | |
| `MAIL_FEATURE_EMPLOYEE_INVITE` | on | |
| `MAIL_FEATURE_SALARY_SLIP` | on | |
| `GOOGLE_CLIENT_ID` | — | required only if Google sign-in is used |

Flags are read **on every send**, not captured at import, so they're operational switches: flip, restart, done. A blank
or unrecognised value falls back to the feature's default and must never read as "off" — silently disabling password
recovery because a variable was declared-but-empty would be the worst possible interpretation.

### Frontend Static Site

| Variable | Notes |
|---|---|
| `VITE_API_URL` | **Baked in at build time.** Changing it needs a rebuild, not a restart. `/api` if you use the rewrite. |
| `VITE_GOOGLE_CLIENT_ID` | Google sign-in button |

⚠️ **Everything in a frontend build is public.** Vite inlines these into the JS bundle where anyone can read them, and
it only exposes `VITE_`-prefixed names at all. No secret — no API key, no database URL — may ever go here. `MAIL_FROM`
and friends are backend-only; putting them on the static site does nothing except leak them.

---

### The traps

**1. Saving a variable is not applying it.** Values are read from the process environment, so nothing changes until the
service restarts. Render usually redeploys on save; confirm it did. A set-but-not-live variable is the most misleading
state available, because the dashboard shows it as correct.

**2. Never quote a value in the dashboard.** `dotenv` strips one matching pair of surrounding quotes from a `.env`
*file*; a dashboard stores them literally. So this works locally and breaks in production:

```
MAIL_FROM="Leave Management System <you@example.com>"     ← wrong in a dashboard
MAIL_FROM=Leave Management System <you@example.com>       ← right
```

The mail layer now tolerates both quoting mistakes specifically because this one already cost a debugging session — but
nothing else does. Quotes are only ever needed in a `.env` file, and only when the value contains a `#`.

**3. `isMailConfigured()` checks the key *and* the sender together.** One of two set still reads as unconfigured, and
the symptom is silence plus `[mail:not-configured]` in the log — not an error.

**4. `CLIENT_ORIGIN` and `CLIENT_BASE_URL` are different things.** The first is CORS (which origins may call the API);
the second is link construction (where to point an emailed URL). They usually hold the same value and do entirely
unrelated jobs.

**5. Dead variables.** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` are no longer read by
anything — SMTP was removed when it turned out to be blocked. Delete them so nobody tries to debug through them.

### Verifying it took

The boot log answers it in one line each way:

```text
Mail provider is not configured …    ← mail credentials did NOT reach the process
[mail] on  MAIL_FEATURE_…            ← flags, as actually resolved
Server running on port 10000         ← it started
```

For the database, `npm run migrate:status` prints the target it resolved before doing anything:

```text
Target: <database> on <host> (via DATABASE_URL)
```
