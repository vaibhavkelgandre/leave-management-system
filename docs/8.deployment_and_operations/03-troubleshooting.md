# Troubleshooting

> Part of [Deployment & Operations](README.md). Every entry here is a failure this deployment has actually produced,
> with what it turned out to be.

---

## Start here

Three checks answer most of it, in this order:

1. **The boot log.** Did the process start? Does it say `Mail provider is not configured`? Are the `[mail]` flags what
   you expect?
2. **`npm run migrate:status`** against that environment. Is the schema current?
3. **Which commit is deployed**, on *both* services. Skew between them is a top-three cause here.

---

## Whole app down

### `503`, with `x-render-routing: hibernate-wake-error`

The process **crashed at startup** — not merely asleep. That header is the distinction. Read the top of the boot log.

Seen once: a dependency present in the working tree's `package.json` but never committed, so the install completed
without it and a top-level `import` killed the process. If the log shows a module-not-found, check that
`package.json` **and** `package-lock.json` are both committed.

### `503`/slow on the first request only

Free-tier hibernation. Normal. The first request after idle takes a few seconds.

### Every direct URL is a blank page, but the app works if you start at `/`

The static site's **SPA fallback rewrite is not being applied**. Without it only `/` serves `index.html`, so any
path entered, emailed, bookmarked or refreshed returns an empty document — which breaks password-reset links,
`/invite/:token`, and every page refresh, while in-app navigation keeps working because that never re-requests a URL.

**Diagnose it from outside, and never by status code** — every failing case here answered `200`:

```bash
curl -s https://<frontend>/reset-password/abc | wc -c
```

Want the same byte count as `curl -s https://<frontend>/ | wc -c` (the `index.html` size). Zero means broken.

The decisive tell: an extensionless path like `/foo` returns `200` with **zero bytes** while `/foo.txt` returns
**404**. A live `/*` rewrite matches *both*, so two different answers prove no rule ran — that is Render's default
static behaviour, not a malformed destination.

**Cause seen here: the Redirects/Rewrites page did not persist the edit.** The form kept showing the right value.
Fix: hard-reload (Ctrl+F5) after Save and confirm the value came back; if it reverted, the save never landed. Prove
saves work at all by deleting a rule you know is live (`/api/*`) and confirming the API breaks. Retype fields rather
than pasting — a trailing space in the `/*` source matches nothing and the UI cannot show it to you.

Rules must be `/api/*` → the backend **above** `/*` → `/index.html`, both **Rewrite**. Render matches top-to-bottom
and stops at the first hit, so the reverse order sends every API call to `index.html`.

### Login answers `500`, but only with the *correct* password

**`JWT_SECRET` is not set.** `signAuthToken` reads it at call time and nothing validates it at boot, so the service
starts, `/health` returns `200`, and the boot log looks normal. A *wrong* password fails at the bcrypt compare and
returns a clean `401`; a *correct* one reaches `jwt.sign(payload, undefined)`, which throws.

**That 401-vs-500 split is the signature** — authentication failing only for valid credentials means the failure is
after the password check, which is where signing happens. Grep the log for `secretOrPrivateKey must have a value`.

It also breaks `POST /auth/register/hr` in a confusing way: the user row commits before the token is signed, so the
account exists while the response `500`s and nobody is signed in — which reads as "registration failed" when it
half-succeeded.

---

## Endpoints failing that exist in the repo

### `404` on a real route, or `422` on a route that should accept the request

**Split-deploy skew.** The frontend is a build ahead of the backend. Check the deployed commit on the backend service.

Two specific shapes seen here:

- `GET /users/me/team/count` → `404`, because the route didn't exist in the deployed backend yet.
- `GET /leave-requests/pending-count` → `422`, which is stranger and worth understanding: with `/pending-count` absent,
  the request fell through to `/:id`, whose `validateParams` rejected `pending-count` as a non-UUID. **A `422` on a
  path segment that isn't an id means the specific route is missing and a dynamic one caught it.**
- Downstream: `Cannot read properties of undefined (reading 'length')` in the console, when a component destructures a
  response shape that never arrived.

⚠️ **You cannot test this by hitting the endpoint unauthenticated.** `router.use(requireAuth)` runs *before* route
matching, so a nonexistent path and a real one both return `401`. Check the deployed commit instead.

### Every browser request fails but curl works

CORS. `CLIENT_ORIGIN` is unset (defaulting to localhost) or doesn't match the frontend origin exactly.

### Login succeeds, then everything is `401`

The auth cookie is being set and not sent back. Cross-origin requires `SameSite=None; Secure`; same-origin via the
`/api` rewrite avoids it. See [01-services-and-topology.md](01-services-and-environment.md).

### A page loads but its data won't, e.g. "Unable to load holidays"

Often an **unmigrated database**, not an API fault. Run `npm run migrate:status`.

---

## Mail

| Log line | Cause | Fix |
|---|---|---|
| `Mail provider is not configured` at boot | `BREVO_API_KEY` or `MAIL_FROM` missing — they're checked together | set both, confirm the restart |
| `[mail:not-configured] to=… subject=…` | same, at send time. ⚠️ **this logs the whole body, including live invite/reset links** | configure it; treat those logs as secrets meanwhile |
| `[mail:disabled] feature=…` | that flow's flag is off | flip it |
| `Mail provider (brevo) rejected the message (401): {"message":"Key not found"}` | **an `xsmtpsib-` key from Brevo's SMTP tab instead of an `xkeysib-` one from API Keys** — the single most likely cause | regenerate on the **API Keys** tab |
| `rejected the message (401)` with a correct-looking key | whitespace-damaged, truncated, or deleted at the provider | verify in isolation: `curl -s -X GET https://api.brevo.com/v3/account -H "api-key: <key>"` → `200` means the key is fine and the problem is how it's stored |
| `rejected the message (400)` naming the sender | `MAIL_FROM` isn't a verified Brevo sender. List them: `curl -s https://api.brevo.com/v3/senders -H "api-key: <key>"` | use one of those addresses exactly |
| `rejected the message (400)` otherwise | malformed payload — e.g. a quoted `MAIL_FROM` | unquote it |
| `Mail provider (…) unreachable: …` | network or the 10s timeout | check provider status |

### The invite panel is amber: "Invited, but the email wasn't sent"

`emailSent: false`. The account **was** created and the link **does** work — that's by design, mail is a side effect
outside the transaction. The cause is one of the rows above, or the backend predates the invite-email code entirely.

### Nothing at all is logged and no mail arrives, for password reset

Two silent-by-design paths: the address isn't an `ACTIVE` user, or the **15-minute per-user cooldown** blocked it. Both
return `200` with no log, deliberately — a distinguishable response would let anyone discover which addresses are
registered.

### Mail arrives in spam

Known and accepted. The sending domain has no SPF/DKIM authorising the provider, because Single Sender Verification
publishes nothing. Fix is Domain Authentication — three CNAME records, needs DNS access. Not a content problem; the
templates already do everything they can.

### Historical: SendGrid, and why the provider moved

SendGrid's free access lasts two months and then stops sending, so mail moved to **Brevo** (permanent free tier,
and single-sender verification that needs no DNS). A SendGrid branch lived in `config/mailer.js` briefly as migration
scaffolding and has been removed: a fallback to a provider whose access expires is worse than none, because
`isMailConfigured()` would still read `true` while nothing could be delivered. `SENDGRID_API_KEY` is no longer read
anywhere — delete it from the service's environment.

### Historical: SMTP

Do not try to go back to SMTP. **Render blocks it.** Established by elimination: `ENETUNREACH` on an IPv6 address
(nodemailer picks the address family at random; Render has no IPv6 route), then `Connection timeout` on 587 after
pinning to IPv4, then the same on 465. A TCP connect timing out at 5s, silently dropped rather than refused, is a
firewall.

---

## Migrations

| Symptom | Cause |
|---|---|
| `0 of 37 recorded` on a working database | the **ledger** is new, not the schema. Baseline it |
| `is violated by some row` on an old migration | replaying a constraint-narrowing file against newer data. Baseline instead — see [03](02-database-and-migrations.md) |
| `Refusing to baseline: … already records N` | already baselined, or a partial run needs `--pending-only` |
| `have been edited` | an applied file changed. Never edit an applied migration |
| `CommandNotFoundException` | `DATABASE_URL=... npm run migrate` is bash syntax; use `$env:` in PowerShell |
| SSL/connection refused | `DB_SSL=true` missing, or the Internal URL used from outside Render |

---

## Browser console noise that isn't a bug

| Message | Why |
|---|---|
| `Cross-Origin-Opener-Policy policy would block the window.postMessage call` | emitted by Google's own `gsi/client` script during popup sign-in. We set no COOP header anywhere. Harmless while sign-in works; the remedy if it ever breaks is GSI config (`ux_mode: "redirect"` or FedCM), not a header of ours |
| `[GSI_LOGGER] … initialize() is called multiple times` | `@react-oauth/google` re-initialising across renders |
| `401` on `GET /api/auth/me` on a public page | the session probe answering "nobody is logged in". Called with `skipAuthRedirect`, so it doesn't bounce you. DevTools paints it red on every public page |
