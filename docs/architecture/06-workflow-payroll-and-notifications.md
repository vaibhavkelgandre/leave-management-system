# Workflow — payroll, payslips, notifications & email

> Part of the [Architecture & Workflow Reference](README.md). If this disagrees with the code, the code wins.

---

## Workflow — payroll run & payslips

### Shape of the module

Payroll is **two-phase on purpose**: HR previews a whole period, reads what would happen to every employee, and then
commits it. Nothing is written by the preview.

```text
POST /api/salary-slips/calculate   { payPeriod, role?, profileStatus? }   → preview, writes nothing
POST /api/salary-slips/confirm     { payPeriod, role?, profileStatus? }   → commits slips, emails PDFs
```

Both are `requireRole("HR_ADMIN", "SUPER_ADMIN")` at the route *and* re-check the role inside
`salarySlipService`, because a service is reachable from more than one route over time.

A run is always scoped to `getHrScopedUsers(actor)` — an HR admin's own subtree, never the whole company. `role` and
`profileStatus` narrow it further *before* anything is computed, so "payroll for verified employees only" never has to
be assembled by hand.

⚠️ **`confirm` recomputes from scratch and never trusts the preview's numbers.** The client sends the same
`payPeriod` and filters, not the figures — otherwise a tampered or merely stale preview would decide what people get
paid.

### The period must be over

`assertPeriodCompleted(payPeriod)` rejects the current or a future month. Paying out a month still in progress would
mean paying for days not yet worked, and every LOP/proration figure would change before the month ended.

---

### Per-employee outcomes

`calculateForSubtree` returns one row per employee in scope, each with exactly one status. This is the heart of the
module:

| Status | Meaning | `computed` |
|---|---|---|
| `ok` | a slip will be created | the figures |
| `skipped` | included in the run, but nothing to issue | `null` |
| `already_generated` | holds a live slip for this period already | `null` |

`ok + skipped + alreadyGenerated === total`, always — the summary can't hide anyone.

#### The four reasons a row is skipped

Checked in this order, and the order matters:

1. **`Profile not yet verified`** — payroll depends on identity having been checked. See
   [08-workflow-documents-and-verification.md](04-workflow-onboarding-and-verification.md).
2. **`Not yet joined for this period`** — the period ends before `joining_date`. There is nothing to compute, as
   opposed to something that computes to zero.
3. **`already_generated`** — checked *before* the salary-structure lookup and the computation. Someone who already has
   a live slip needs neither, and re-deriving figures that can't be committed would only raise the question of why
   they differ from the slip they'll actually keep. That's also why `computed` is `null`.
4. **`No salary structure assigned`** — nothing to compute from.

Plus a fifth, decided inside `computeSlip`:

5. **Net pay ≤ 0 → `skipped`.** A payslip claiming someone earned nothing is worse than no payslip: it looks like a
   statement of fact about their pay rather than a gap in configuration. The computed figures are still attached to
   the row so HR can see *why* it came to zero and fix it, rather than only being told it was skipped.

⚠️ **`already_generated` is counted separately from `skipped`, not folded into it.** "Nothing to do here, by design"
and "this one needs your attention" are different messages, and the client badges them differently. This also fixed a
real bug: the check used to happen only at confirm time, so HR read **Ready** in the preview for someone who was then
silently skipped on approve.

---

### Committing

```text
POST /api/salary-slips/confirm
 ↓
role check, assertPeriodCompleted
 ↓
calculateForSubtree(...)  -- recomputed, same filters
 ↓
okRows = status "ok";  skipped = status !== "ok"      ← not `=== "skipped"`, so already_generated
                                                        and nothing-payable rows can't vanish
 ↓
race backstop: re-query live slips for okRows; anything now ACTIVE moves to skipped
 ↓
replaceSlipsForPeriod({ payPeriod, actorId, rows })
 ↓
notifySalarySlipsGenerated(committed, ...)     -- committed rows only; a skipped row got no slip
 ↓
void emailCommittedPayslips(committed, payPeriod).catch(log)   -- fire-and-forget
 ↓
respond { committed, skipped }
```

**Re-running a period requires voiding first.** `replaceSlipsForPeriod`'s own `ON CONFLICT` would happily overwrite a
live slip, which would erase someone's payslip without HR ever making that an explicit, reasoned decision. A `VOIDED`
slip is different: it's how a period is deliberately reopened, so that employee stays in `okRows` and the commit both
archives the voided figures and reactivates the row.

The backstop after `calculateForSubtree` looks redundant — the preview already tags those rows — and it is, in normal
use. It stays for the narrow race it always implicitly covered: two HR admins confirming the same period concurrently
both compute before either commits, and this is the later of the two checks.

---

### Emailing the payslips

```text
emailCommittedPayslips(committedRows, payPeriod)
 ↓
re-fetch the committed slips (joined shape) in ONE query
 ↓
for each slip, sequentially:
      renderPayslipPdfBuffer(slip)  →  sendSalarySlipEmail({ ..., pdf })
 ↓
console.log(`[payslip-email] period=… sent=… failed=…`)
```

Four decisions worth not undoing:

- **Fire-and-forget, and for a different reason than the password-reset send.** That one is about a timing oracle;
  this one is about the response. A run can commit a couple of hundred slips, each needing a PDF render plus a
  provider round trip — awaiting them would hold HR's request open for minutes and hit the proxy timeout with payroll
  already committed.
- **Nothing throws.** By the time this runs, payroll is committed and the response has gone. There is nothing left to
  fail into, so every error is logged instead.
- **Sequential, not parallel.** Providers throttle per connection and free tiers cap daily volume, so 200 concurrent
  sends is the shape most likely to get the entire run rejected. Each employee is independent: one bad address drops
  one email and the loop continues.
- **It re-fetches rather than reusing `committed`.** `RETURNING` gives `salary_slips` columns only, while the PDF and
  the email both need the joined employee name/email/designation/PAN. One query for the batch, not one per employee.

`renderPayslipPdfBuffer` exists alongside `renderPayslipPdf` rather than replacing it: an attachment needs the whole
file in memory, while the HTTP download wants a stream it can pipe. A run buffers one payslip at a time, never all of
them.

Delivery is switchable at runtime by `MAIL_FEATURE_SALARY_SLIP` — with it off, the in-app notification and
`GET /salary-slips/:id/pdf` still work. See
[12-workflow-notifications-and-email.md](06-workflow-payroll-and-notifications.md).

---

### Reading and voiding slips

| Endpoint | Who | Notes |
|---|---|---|
| `GET /salary-slips/mine` | any authenticated | **own slips only, regardless of role** — unpaginated, it's ~36 rows |
| `GET /salary-slips` | HR-tier | the scoped team list; **paginated** `limit`/`offset` → `{ slips, total }` |
| `GET /salary-slips/:id` | any authenticated | row-level check inside the service, like `leave-requests/:id` |
| `GET /salary-slips/:id/pdf` | any authenticated | streamed, not buffered |
| `POST /salary-slips/:id/void` | HR-tier | `reason` required |

⚠️ **`/mine` and the HR list used to be one function branching on `actor.role`**, which meant an HR admin's "your
slips" returned the same rows as "your team's slips" — the page read as duplicated. They're deliberately separate now;
don't re-merge them.

Voiding records a reason and fires `notifySalarySlipVoided`. It's the only way to reopen a period, which is what makes
"already received" a safe default rather than a dead end.

### Failure modes worth knowing

| Symptom | Cause |
|---|---|
| Every row `Profile not yet verified` | verification hasn't happened for that subtree |
| A row reads "already received" | a live slip exists — void it to re-run that employee |
| Row skipped with figures shown | net pay computed to ≤ 0 — read the figures, fix the structure |
| `calculate` rejected outright | the period isn't over yet (`assertPeriodCompleted`) |
| Slips committed, no emails | check `[payslip-email] … failed=` and the mail feature flag |
| HR sees fewer employees than expected | `getHrScopedUsers` — a run is subtree-scoped, never company-wide |

---

## Workflow — notifications & outbound email

### Two separate delivery channels

| Channel | Reaches | Covers |
|---|---|---|
| **In-app** (`notifications` table + nav bell) | the logged-in user | **every** notable event, ~18 types |
| **Email** | the user's inbox | exactly **three** flows |

No SMS, no push, anywhere. Everything in-app; only three things leave the building.

---

### Part A — In-app notifications

`notificationService.js` has two halves that never call each other:

**The read/write API**, behind `notificationController`:

| Endpoint | Returns |
|---|---|
| `GET /api/notifications` | `{ notifications, total }`, newest first, `unreadOnly` optional |
| `GET /api/notifications/unread-count` | just the number — backs the bell badge |
| `PATCH /api/notifications/:id/read` | idempotent; re-marking returns it unchanged |
| `PATCH /api/notifications/read-all` | bulk |

`limit` is clamped to `[1, 50]` **inside the service**, not only in the validator — belt and braces, so a direct call
from a test or a future caller can't ask for the whole table.

A notification belonging to someone else is a **404, not a 403**: the same don't-reveal-existence policy as every other
per-record endpoint (NFR-5).

⚠️ **`/unread-count` exists so the bell doesn't fetch a list to count it.** That's the precedent every other count
endpoint in this app copied — see the Pagination & Count Endpoints section of `.claude/rules.md`.

**The internal `notify*` helpers**, called by other services right after a state change succeeds:

```text
leaveRequestService  → notifyLeaveRequestSubmitted / Decided / WithdrawnOrCancelled
userService          → notifyProfileSubmitted / Verified / SentBack / Created
                       notifyManagerReassigned / TeamMemberAssigned
                       notifyAccountStatusChanged / InviteAccepted
salarySlipService    → notifySalarySlipsGenerated / SalarySlipVoided
salaryStructure      → notifySalaryStructureUpdated
delegation           → notifyDelegationNominated
sweep (timer)        → notifyDelegationStarted / DelegationEnded
```

⚠️ **Every one of these is a non-critical side effect.** They run *after* the state change has committed, and a
failure must never fail the request that caused it — the leave request was still approved, the profile was still
verified. This is stated on the helpers themselves; don't "improve" one into a throw.

#### Recipient resolution

`resolveManagerOrNearestHrAncestor` reuses `userRepository.findReportingLine` rather than adding new tree-walking
logic. One query answers both questions depending on how far up you read it:

- *who is this employee's manager* → the first row
- *who is their nearest HR ancestor* → keep reading until a `HR_ADMIN` appears

That's why a submitted profile notifies **one** HR admin — the one whose subtree actually contains this employee —
rather than every HR admin in the company.

#### Time-based notifications

Every `notify*` above fires from the request that caused it. Delegation start/end has no such request: nobody performs
an action on the day a delegation begins. Hence `notificationSweepService.sweepDelegationTransitions()`, called from
`server.js` on a timer.

It is **safe to call repeatedly** — on an hourly interval, or after a restart — because
`notifyDelegationStarted`/`Ended` dedupe through `existsNotificationCreatedToday`. A second call the same day is a
no-op.

It lives in its own file rather than inside `delegationService.js` so that "runs on a schedule" stays visibly separate
from request-driven CRUD, and so a second sweep has an obvious home.

#### The type constraint is a migration trap

`notifications.type` is guarded by a `CHECK` constraint listing every valid value, and **that list has been widened
twice** (033 → 16 values, 036 → 17 with `PROFILE_CREATED`).

⚠️ Adding a notification type means a new migration widening that constraint. And replaying an *older* widening
migration against newer rows fails — `033` re-imposed against `036`-era data gives
`check constraint "notifications_type_check" is violated by some row`. That's the concrete reason the migration ledger
exists; see the Database Rules section of `.claude/rules.md`.

---

### Part B — Outbound email

Four files, each allowed to know one thing:

| File | Owns | Must not know |
|---|---|---|
| `config/mailer.js` | *how* to reach a provider — the Brevo HTTPS call (SendGrid retained as a fallback), its timeout, From parsing | what any message says, or whether it's on |
| `config/mailFeatures.js` | *whether* a flow may send right now | templates, recipients, transport |
| `utils/mailLayout.js` | the shared HTML/text shell | which flows exist |
| `services/mailService.js` | *what* each message says | provider details, flag plumbing |

Adding an email is three additive steps: a `FEATURE_DEFINITIONS` entry, a `sendXEmail` template, and a call from the
service that owns the event. The new sender inherits the flag, the `MAIL_ENABLED` kill switch, the unconfigured-dev
fallback and the never-send-under-test guard for free.

⚠️ **Every template goes through `mailService`'s own `dispatch` helper, never `sendMail` directly** — `dispatch` is the
only thing enforcing the feature flag, and a flag check one line away from a send is what goes missing on the fourth
email someone adds.

#### The three flows

| Flow | Flag | Degrades to |
|---|---|---|
| Password-reset link | `MAIL_FEATURE_PASSWORD_RESET` | **nothing** — returning the link in an API response would let anyone reset anyone's password |
| Invite link | `MAIL_FEATURE_EMPLOYEE_INVITE` | the link is also returned to HR, and the UI promotes it |
| Payslip PDF | `MAIL_FEATURE_SALARY_SLIP` | the in-app notification and the PDF download endpoint |

`sendMail` returns `true` **only when the message actually reached the provider**, and `false` when the test guard,
missing config, or a flag stopped it. The invite flow's `emailSent` depends on that distinction — don't re-derive it
from `isMailConfigured()` at a call site.

#### Why an HTTP provider over HTTPS and not SMTP

> The provider is **Brevo** as of September 2026 — SendGrid's free tier lasts two months then stops sending. The
> reasoning below is unchanged by that; only the endpoint, the `api-key` header and the field names differ. See the
> Outbound Email section of [`.claude/rules.md`](../../.claude/rules.md) for what the swap changed.

**Render blocks outbound SMTP.** Established by elimination:

1. Sends died with `connect ENETUNREACH 2404:6800:…:587` — nodemailer resolves A and AAAA records separately and picks
   one *at random*; `smtp.gmail.com` publishes one of each; Render has no IPv6 route.
2. Pinning to IPv4 fixed that and revealed `Connection timeout` on **587**.
3. Port **465** timed out identically.

A TCP connect timing out at 5s — when a handshake to Google is one round trip — silently dropped rather than refused,
is a firewall. HTTPS on 443 isn't blocked, which is the whole reason the current transport works.

There is deliberately **no `@sendgrid/mail` dependency**: the send endpoint is one JSON POST and `fetch` is global.
An uncommitted `nodemailer` entry in `package.json` once crashed this deploy at boot, and zero dependencies makes that
unreachable.

#### Sender identity

`isMailConfigured()` means a provider key (`BREVO_API_KEY`, else `SENDGRID_API_KEY`) **and** `MAIL_FROM`. Unlike the SMTP setup it replaced there's **no
fallback sender** — SMTP could default to the authenticated mailbox because that mailbox *was* the sender, whereas
SendGrid 403s an unverified `from`. So a missing `MAIL_FROM` reads as unconfigured rather than sending as someone else.

`MAIL_FROM` tolerates both quoting mistakes (`"Name <addr>"` and `"Name" <addr>`), because dotenv strips surrounding
quotes from a `.env` file and hosting dashboards do not — the value that works locally arrives quoted in production.

⚠️ **The unconfigured fallback logs the whole message body, links included.** Fine on a laptop; in a deployed
environment it publishes live invite and reset tokens into log aggregation. `isMailConfigured()` must be true anywhere
real.

#### Deliverability

Mail currently lands in recipients' **spam** folders, and that is a known, accepted state — see the Outbound Email
section of `.claude/rules.md`. It's an authentication gap, not a content one: Single Sender Verification publishes
nothing, so SPF/DKIM checks on the From domain find nothing authorising SendGrid. The fix is Domain Authentication
(three CNAME records), which needs DNS access.

Everything the templates can contribute is already done: a plain-text part alongside the HTML, a preheader, no remote
images, no link shorteners, and all SendGrid click/open/subscription tracking disabled — click tracking would rewrite
every link to a `sendgrid.net` redirect, which routes a single-use credential through a third party and destroys the
one signal that separates a real invite from phishing.

### Failure modes worth knowing

| Symptom | Cause |
|---|---|
| `Mail provider is not configured` at boot | no provider key (`BREVO_API_KEY`/`SENDGRID_API_KEY`) or no `MAIL_FROM` |
| `[mail:not-configured]` at send time | same, and the body is now in your logs |
| `[mail:disabled] feature=…` | that flow's flag is off |
| `(403)` from the provider | `MAIL_FROM` is not a verified sender |
| `(401)` | bad or whitespace-damaged API key |
| Invite panel amber, "email wasn't sent" | `emailSent: false` — one of the four rows above |
| Everything in spam | no SPF/DKIM for the From domain — accepted, needs DNS |
