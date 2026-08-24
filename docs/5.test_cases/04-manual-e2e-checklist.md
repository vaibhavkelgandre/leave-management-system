# Manual end-to-end checklist

> Part of [Test Cases](README.md). This exists because there is **no automated E2E suite** (gap G35) — every existing
> test is either a backend integration test or a jsdom component test, so nothing exercises a real browser across
> more than one logged-in user.
>
> Different from [`docs/6.demo_walkthrough/`](../6.demo_walkthrough/README.md), which is a *presentation* script for
> showing the app off. This is a *test* pass: it includes the refusals, the authorization probes, and the cases where
> the interesting outcome is that something is blocked.
>
> Work top to bottom — later sections depend on state the earlier ones create.

---

## Before you start

**Use a database you're willing to dirty.** Several cases below create employees, move balances and void payslips.
None of it is reversible through the UI.

Setup commands are in [`docs/10.commands/01-setup.md`](../10.commands/01-setup.md). You need:

- Both servers running (`npm run dev` in `server/` and `client/`)
- Migrations current — `npm run migrate:status` should say nothing pending
- One login per role. `npm run seed` creates them if you don't already have them
- **At least one leave type with `requires_document: false` and an entitlement ≥ 10**, and a second type you're
  willing to discontinue in §7
- Four browser windows, one signed-in role each. Use separate profiles or incognito windows — same-browser tabs share
  the cookie and you'll keep logging each other out

| Window | Role |
|---|---|
| A | `SUPER_ADMIN` |
| B | `HR_ADMIN` |
| C | `MANAGER` |
| D | `EMPLOYEE` (created in §1) |

Record the result of each case as you go. A case that needs a step skipped is a **fail**, not a pass with a note.

---

## 1. Onboarding — the only way into the app

There is no public registration, so every account starts here.

| # | Steps | Expected |
|---|---|---|
| 1.1 | **B** → `/dashboard/employees/new`. Fill first/last name, a fresh email, role `EMPLOYEE`, reports-to = the manager | Success panel appears with an **invite link** and a copy button |
| 1.2 | Note whether it says the email was sent | With mail unconfigured locally it should say it wasn't, and promote the link — **not** show an error. The account exists either way |
| 1.3 | Submit the **same email again**, but change the name and role in the form | `200`, panel says the invite was **re-sent**, and states that the stored name/role won — the values you just typed are ignored |
| 1.4 | Check the employee list | **One** row for that email, not two. Creator attribution unchanged |
| 1.5 | Paste the link into **D** (logged out). Set a password, submit | Redirected to sign-in, or signed in — no error |
| 1.6 | Reuse the **same link** a second time | Refused. The token is single-use |
| 1.7 | Log in as the new employee in **D** | Dashboard loads. Bell shows a notification telling them to complete their profile |

**Why 1.3–1.4 matter:** re-inviting used to hit a unique-index violation and surface as "a record with these details
already exists", with no way to recover for the rest of the 12-hour window.

---

## 2. Authorization — the top review criterion

Probe these directly. Each should be refused **by the server**, not merely hidden by the UI.

| # | Steps | Expected |
|---|---|---|
| 2.1 | **D** → try to reach `/dashboard/employees` by typing the URL | Bounced to `/403` |
| 2.2 | **B** (HR) → try `/dashboard/employees` | Bounced to `/403`. Company-wide views belong to `SUPER_ADMIN`; HR's view is My Team |
| 2.3 | **C** (manager) → open Approvals | Only their own team's requests. No stranger's row |
| 2.4 | **D** → submit a request, then in **D** try to approve it | No approve control exists for your own request. Nobody approves their own leave |
| 2.5 | **A** (`SUPER_ADMIN`) → open a request on All Requests | Details open, but **no override buttons** — super admin deliberately has no override power |
| 2.6 | **B** (HR) → open a *pending* request in their branch | Approve/Reject are **absent**; only override, and only once a manager has decided |
| 2.7 | **B** → override a decided request, leaving the comment blank | Refused. An override needs a stated reason, unlike a plain approve |

**2.6 is the one people get wrong.** HR does not decide directly — the employee's actual manager does, and HR
overrides afterwards.

---

## 3. Working days and balances — the arithmetic

| # | Steps | Expected |
|---|---|---|
| 3.1 | **D** → My Leave → Request Leave. Pick a Mon–Fri range | Live preview says **5 working days** before you submit |
| 3.2 | Extend the range across a weekend | The count rises by the weekdays only — Saturday and Sunday don't add |
| 3.3 | Pick a range containing a public holiday | Holiday excluded from the count |
| 3.4 | Tick a half-day flag | Count drops by 0.5 |
| 3.5 | Submit. Note the balance before and after | Days move into **pending**, not taken. Remaining drops by exactly the previewed figure |
| 3.6 | **C** → approve it | Pending → **taken**. The total is unchanged, the column moved |
| 3.7 | **D** → cancel it (dates still in the future) | Both figures return. Balance is exactly what it was in 3.5 before submitting |
| 3.8 | Submit a request overlapping one still pending or approved | Refused with a message about the overlap, not a generic error |
| 3.9 | Submit a request larger than the remaining balance | Refused — unless the type allows a negative balance, in which case allowed and remaining goes below zero |
| 3.10 | Submit a range that is **only** a weekend | Refused — zero working days |

**3.5 → 3.7 is the assertion that matters most.** The number the employee saw before submitting must be the number
charged, and a full submit→approve→cancel cycle must land back on the original balance exactly.

---

## 4. State transitions

| # | Steps | Expected |
|---|---|---|
| 4.1 | **D** → withdraw a request that is still pending | Allowed. Pending days released |
| 4.2 | Try to withdraw an **approved** request | No withdraw control. Cancel is the approved-request action |
| 4.3 | Try to cancel an approved request whose dates have **already started** | Refused |
| 4.4 | **C** → try to approve a request the employee already withdrew | Refused as an illegal transition |
| 4.5 | **B** → override an approved request to rejected, with a comment | Allowed. Trail records it as an override, naming HR |
| 4.6 | Open Details → audit trail on any request that's been through several steps | Every step listed with actor, timestamp and comment. **Nothing edited or missing** — the trail is append-only |

---

## 5. Delegation — and the window ending

| # | Steps | Expected |
|---|---|---|
| 5.1 | **C** → nominate a delegate for a range **covering today** | Saved. Delegate list shows it |
| 5.2 | Log in as that delegate | Dashboard tile says they're covering for the manager. **Approvals link appears in the nav** even if they're a plain employee |
| 5.3 | As the delegate, open Approvals | The manager's team's requests are listed, labelled "Delegated for {manager}" |
| 5.4 | As the delegate, approve one | Allowed. The record shows both who acted and who they acted for |
| 5.5 | **C** → nominate a delegate for a range that has **already ended** | Saved, but that delegate sees no Approvals link and no team requests |
| 5.6 | As the expired delegate, try to act on a request anyway | Refused — and with a `404`, the same answer a total stranger gets |

**5.6 is a named deliverable requirement**: a delegate's authority stops when their window ends.

---

## 6. A holiday declared inside live leave — new, untested manually

This is the behaviour shipped most recently, and it's the one with the most surprising blast radius.

| # | Steps | Expected |
|---|---|---|
| 6.1 | **D** → submit a Mon–Fri request. **C** → approve it. Note the employee's remaining balance | 5 days taken |
| 6.2 | **B** → Holidays → add a holiday on the **Wednesday inside that range** | Saved, and an **amber notice** says N leave request(s) were recounted |
| 6.3 | **D** → reload My Leave | The request now shows **4** days, and remaining balance is **one day higher** |
| 6.4 | **D** → open the bell | A notification quoting **both** figures — "4 instead of 5" — not just "your leave changed" |
| 6.5 | **B** → **delete** that holiday | Amber notice again. The employee is back to 5 days and the original balance |
| 6.6 | **B** → add a holiday on a date **outside** anyone's leave | No notice, no notifications, nobody's balance moves |
| 6.7 | Repeat 6.2 against a **withdrawn** request | Untouched. It already released its days |
| 6.8 | Check the employee's leave history after 6.2 and 6.5 | Balance correct at every step, and the audit trail shows **no new decision** — the leave was still submitted and approved when it was |

---

## 7. Leave type lifecycle — new, untested manually

| # | Steps | Expected |
|---|---|---|
| 7.1 | **D** → take and get approved some leave on a second leave type | Days recorded against it |
| 7.2 | **B** → Leave Types → deactivate that type | Message states how many requests are **still awaiting a decision** on it |
| 7.3 | **D** → My Leave | The type is **still listed**, badged **"Discontinued"**, showing the days they took |
| 7.4 | **D** → Request Leave | That type is **not** in the picker |
| 7.5 | **B** → deactivate a type **nobody has used** | **D** doesn't see it at all — a full untouched entitlement would read as leave they could still take |
| 7.6 | **B** → edit an active type's entitlement from 12 to 15, leaving "apply to current year" **off** | Reports **0 balances updated**. **D**'s entitlement stays 12 |
| 7.7 | Same edit with the option **on** | Reports the number of balances updated. **D**'s entitlement becomes 15 |
| 7.8 | Repeat 7.7 immediately, unchanged | Reports **0** — the count means rows that changed, not rows that matched |
| 7.9 | Reduce an entitlement **below** what someone has already taken | Allowed, and their remaining goes negative. This is reported, not prevented |

---

## 8. Payroll guards

| # | Steps | Expected |
|---|---|---|
| 8.1 | **B** → Payroll → try to run the **current, unfinished** month | Refused. Only a fully completed past month is runnable |
| 8.2 | Try a month in the **future** | Refused |
| 8.3 | Run a completed month. Read the preview | Per-employee rows: `Ready`, skipped-with-reason, or **"Already received"**. Counts add up to the total |
| 8.4 | Confirm, then run the **same** period again | Everyone already holding a slip is skipped **by name and reason**, not silently overwritten |
| 8.5 | Void one employee's slip, re-run | That employee returns to `Ready`. Voiding is the correction path |
| 8.6 | Check a deactivated employee is in scope | Skipped as **"Account is no longer active"** — no payslip, no email |
| 8.7 | Hover the **VOIDED** badge on a slip | Tooltip shows the **reason** it was voided |

### 8b. The payroll lock

| # | Steps | Expected |
|---|---|---|
| 8.8 | Confirm payroll for a completed month for an employee. Then have **C** try to approve a *pending* request whose dates fall in that month | Refused, naming the period and saying HR must void the payslip |
| 8.9 | As that employee, **withdraw** the same request | **Allowed** — a pending request never counted toward LOP, and this is their only remaining exit |
| 8.10 | Void the payslip, then approve again | Allowed |

### 8c. Employment dates and exit

| # | Steps | Expected |
|---|---|---|
| 8.11 | **D** → Profile → look for joining date / last working day | **Not editable.** These are HR-only — they drive pay |
| 8.12 | **B** → an employee's detail page → set a joining date mid-month, then run that month | Earnings pro-rated to days employed. Fixed deductions (PF, ESIC, tax) **not** pro-rated |
| 8.13 | **B** → Record exit with a last working day mid-month, where a full-month payslip already exists | Slip is **voided**, message names the periods, and the employee is told in-app **and** by email |
| 8.14 | **D** → check the bell and the payslip list | Notified, and the voided slip shows its reason on hover. **No new payslip was emailed** |
| 8.15 | Change that leaving date **again**, to a later month | Any slip that no longer agrees is voided too — including one pro-rated by the *old* date |
| 8.16 | Give that employee a raise, then re-run the voided month | Figure uses the **old** salary, and the row says an archived salary was used. A correction recomputes days, never salary |
| 8.17 | **D** → try to submit leave starting **after** their last working day | Refused |

**8.15 was a real underpayment found in live use** — a slip pro-rated by an earlier leaving date was never revisited
when the date moved. **8.11 was a live exploit**: the joining date was self-editable while already setting pay.

---

## 9. Scope — two roles, two different answers

| # | Steps | Expected |
|---|---|---|
| 9.1 | **A** (super admin) vs **B** (HR) → dashboard "on leave today" | A sees company-wide; B sees their own branch only |
| 9.2 | **B** → HR Reports → filter for an employee in **another** HR admin's branch | Zero rows — the same answer as an id that doesn't exist |
| 9.3 | **B** → try to open a request from another branch by URL | `404` |
| 9.4 | **B** → try to change the manager of someone they neither invited nor have in scope | No control offered, and the endpoint refuses |
| 9.5 | **A** → try to deactivate themselves via another account | Nobody's subtree contains the root |

---

## 10. Phone width (NFR-8)

Resize to 375px, or use device emulation, and walk §3 again.

| # | Expected |
|---|---|
| 10.1 | Sidebar becomes an off-canvas drawer; navigating closes it |
| 10.2 | Every table scrolls horizontally **within its card** — the page itself never scrolls sideways |
| 10.3 | No badge splits across two lines into stacked half-pills |
| 10.4 | The request form and its live day-count preview are both usable without zooming |

---

## Reporting what you find

For anything that fails, capture: the role, the URL, what you did, what you expected, what happened, and whether the
network tab shows a `4xx`/`5xx` or a silent success. A UI that hides a control is a different bug from a server that
allows the action — and for this project's review criteria, the second is much worse.
