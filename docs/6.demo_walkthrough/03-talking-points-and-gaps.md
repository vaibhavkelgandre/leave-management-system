# Talking points, likely questions & known gaps

> Part of the [Demo Walkthrough](README.md). Reference, not a script — read before, not aloud.

---

## Talking points & likely questions

### The five decisions worth defending

**1. No ORM. Raw parameterized SQL.**
Every query is visible and tunable, and there's no layer guessing what SQL to emit. The cost is more typing; the
benefit is that when a list is slow you can read the exact query and add the exact index — which is what
`idx_leave_requests_employee_start_date` is. Parameterized throughout, so injection isn't on the table.

**2. Balances are derived, never stored.**
Every balance is a `SUM()` over an append-only ledger. A stored counter would need correct arithmetic on submit,
approve, reject, withdraw, cancel and HR override — six chances to be off by one, and no way to notice. Deriving it
means the number and its history cannot disagree, because they're the same thing.

**3. Layered: routes → validators → controllers → services → repositories.**
Each layer has one job. Validation is a Zod schema at the edge, so a controller never sees a malformed body.
Authorization lives in services, because the same rule is reachable from more than one route. SQL lives in
repositories, so "how is this stored" is answerable in one place.

**4. Authorization is server-side, and out-of-scope reads are 404.**
`403` tells you a record exists. `404` doesn't. Since the brief expects someone to open the network tab and change an
id, that distinction is the difference between leaking your org chart and not.

**5. Feature flags for outbound email.**
Three flows send mail, each switchable by an environment variable. Turning off payslip email in production is a
restart, not a deploy — and each flow degrades to something rather than breaking, except password reset, which
deliberately has no fallback because returning a reset link in an API response would let anyone reset anyone's
password.

### Questions you will get

**"What happens if the email provider goes down?"**
Nothing breaks. The account, its balances and the invitation row all commit before the send is attempted; the invite
link is returned to HR and the UI promotes it. Payslip email happens after the response, sequentially, and one failure
drops one email. Password reset is fire-and-forget by design — and that's a security decision, not a performance one:
awaiting an SMTP handshake takes seconds for a real account and milliseconds for an unknown one, which is a measurable
way to discover which addresses are registered.

**"Can two people approve the same request at once?"**
The state machine rejects the second — an illegal transition is a `409`. The same pattern protects payroll: two HR
admins confirming the same period both compute before either commits, and the later one finds the slips already live
and reports them as skipped.

**"Is it tested?"**
312 server tests across 33 files, integration-level against a real Postgres database, plus 431 client tests. Not
mocked repositories — actual SQL against an actual schema, which is the only way to catch the class of bug where the
query is wrong rather than the JavaScript.

**"How do you deploy schema changes?"**
A `schema_migrations` ledger. Each migration file runs once, in its own transaction together with its ledger row, with
a checksum so an already-applied file that's been edited stops the run. Deliberately **not** wired into deploy — a bad
migration shouldn't take down production unattended. See
[`docs/8.deployment_and_operations/`](../8.deployment_and_operations/README.md).

**"What would you do next?"**
Named honestly in [07-known-gaps.md](03-talking-points-and-gaps.md). The top three: closing CSRF properly (the defences that
hold today are incidental), domain authentication for email deliverability, and actually load-testing the 200-employee
target rather than only indexing for it. IP-level rate limiting used to head this list and is now built
(`server/src/middlewares/rateLimiter.js`).

**"Why is X hardcoded / simplified?"**
Several simplifications are deliberate and documented: a leave request overlapping a report period counts in full
rather than pro-rated; the year-boundary balance rule; no partial-day leave. Each is written down as a decision rather
than discovered as a surprise — say which it is and move on.

### Numbers worth knowing

| | |
|---|---|
| Migrations | 37, ledger-tracked |
| Server tests | 312 across 33 files |
| Client tests | 431 across 63 files |
| Roles | 4 (`EMPLOYEE`, `MANAGER`, `HR_ADMIN`, singleton `SUPER_ADMIN`) |
| Notification types | ~18, all in-app |
| Email flows | 3, individually flagged |
| Target scale | 200 employees × 3 years (NFR-7) |

### Tone advice

The guards are the product. Anyone can build a form that creates a leave request; the interesting work is that a
rejected document blocks verification, that a zero-net-pay employee doesn't get a payslip, that a withdrawn leave
returns the balance exactly. **Most of those exist because they were found as bugs and fixed** — say so. "We shipped
this, then noticed HR could verify a profile while skipping a document, so we made it impossible" is a better story
than a feature list, and it's true.

---

## Known gaps

The rule: **name it, say why, say what it would take.** A known gap stated plainly reads as engineering judgement. The
same gap discovered by the audience reads as an oversight.

---

### Security

| Gap | What to say |
|---|---|
| **Rate limiting is per process, not shared** | "This *was* the top HIGH finding — there was none at all. Every pre-auth route is limited by IP now: login counts failed attempts only, so an office behind one NAT is never throttled, while password reset counts successes too because a success is what sends mail. What's still true is that the counters live in memory, so they reset on deploy and wouldn't be shared across a second instance — that's a Redis store, and it only matters once we scale out." |
| **Invite/reset links logged when mail is unconfigured** | "There's a dev fallback that logs the message body so you can work without credentials — and it contains the live link. Fine on a laptop, a credential leak in a deployed environment. The rule is that mail must be configured anywhere real, and it is." |
| **JWT in an httpOnly cookie, 8h, no refresh flow** | "Stateless, so there's no server-side session to invalidate — but every request re-fetches the user, so deactivating someone takes effect on their next request. No refresh-token rotation; a longer-lived deployment would want one." |

### Deliverability

**Email lands in spam.** Accepted, deliberately, for now.

> "Single Sender Verification proves we own the mailbox but publishes nothing, so a receiver checking SPF and DKIM for
> the sending domain finds nothing authorising the provider — and Gmail has been strict about that since 2024. The fix
> is Domain Authentication: three CNAME records. It needs DNS access to the domain, which is why it's not done yet.
> Everything the templates can do is already done — plain-text part, preheader, no remote images, no link shorteners,
> and all provider click-tracking disabled so links point at our own domain."

### Performance

| Gap | What to say |
|---|---|
| **Never load-tested** | "Indexed and paginated for the 200-employee, 3-year target, but never measured against it. Indexed-for is not the same as verified-at, and I'd rather say that than imply a number I haven't seen." |
| **Free-tier hosting hibernates** | "The backend sleeps when idle and takes a few seconds to wake. If the very first click of this demo hangs, that's what it is." |

### Product

| Gap | What to say |
|---|---|
| **No resend-invite endpoint** | "An expired invite means HR re-fills the form, because the pending account is deleted when the link lapses. The 12-hour window is deliberately short since the link is a credential — but a resend endpoint should come before shortening it further." |
| **No partial-day leave** | "Whole days only. Half-days would change the ledger's unit from a day to a fraction, which touches every balance calculation — a deliberate scope decision, not an oversight." |
| **Report periods count in full** | "A leave request that only partly overlaps a report period is counted in full rather than pro-rated. Documented simplification, same category as the year-boundary balance rule." |
| **No bulk actions** | "No 'approve all'. For approvals that's arguably correct — each decision should be a decision — but bulk document review would genuinely help HR." |

### Testing

| Gap | What to say |
|---|---|
| **Two pre-existing lint errors** | "`setState` inside an effect in the salary slips page. Known, flagged, not yet fixed — it's a correctness smell rather than a bug, and it predates the current work." |
| **Missing test cases are catalogued** | "Our own test doc lists what *isn't* covered as well as what is. Knowing the holes is more useful than an unqualified 'it's tested'." |

### Operations

| Gap | What to say |
|---|---|
| **Migrations are manual** | "By choice. The ledger tells you what's pending; running it is a deliberate act. Auto-running on deploy means a bad migration takes down production unattended, on a tier with no shell to recover from." |
| **Split-deploy skew is possible** | "Frontend and backend are separate services, so the frontend can be a build ahead. That produced 404s once that looked exactly like broken features. Deploy the backend first." |
| **No staging environment** | "Dev, test, and production. A staging environment would want the invite/reset console-logging turned off before it held real accounts." |

---

### If someone finds something genuinely new

Say so, write it down, move on. **Do not** debug it live — a demo has no stack trace and no time, and an audience
watching someone flail loses more confidence than the bug itself ever cost. "Good catch, that's new, I'll take it
away" is a complete answer.
