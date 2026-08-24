// Salary slip generation (Module 5 v2, FR-025): HR picks a pay period; the
// system computes each payroll-ready employee's net pay from their
// salary_structures row plus LOP (loss-of-pay) days derived from approved
// leave requests — no CSV, no manual monthly re-entry. "Calculate" is a
// pure read (nothing written); "confirm" re-runs the same calculation and
// commits it. Recomputing at confirm time (rather than trusting whatever
// the client saw in the preview) means there's no client-supplied payroll
// data to smuggle at all — every figure always comes from the DB state at
// the moment of the call.
import { isInActorsHrScope, getHrScopedUsers } from "./hrScopeService.js";
import { findStructureByEmployeeId } from "../repositories/salaryStructureRepository.js";
import { findLopWorkingDays, findTotalLeaveWorkingDays } from "../repositories/leaveRequestRepository.js";
import {
    findSlipsByEmployeeIds,
    countSlipsByEmployeeIds,
    findSlipById,
    replaceSlipsForPeriod,
    voidSlip,
} from "../repositories/salarySlipRepository.js";
import { notifySalarySlipsGenerated, notifySalarySlipVoided } from "./notificationService.js";
import { renderPayslipPdfBuffer } from "./payslipPdfService.js";
import { sendSalarySlipEmail, sendSalarySlipVoidedEmail } from "./mailService.js";
import { formatPayPeriod } from "../utils/payPeriod.js";
import { badRequest, forbidden, notFound, conflict } from "../utils/appError.js";

// Both the preview (calculateForSubtree) and the confirm-time backstop
// report this, so it lives in one place — two wordings for one condition is
// how a UI ends up looking like it's describing two different problems.
const ALREADY_GENERATED_REASON =
    "Already received a payslip for this period — void the existing slip first to re-run";

// Reconstructs the salary basis a previous payslip for this period was built
// from, in the shape computeSlip expects a salary_structures row to be.
//
// Input: a slip row (any status). Output: an object with the same component
// keys `findStructureByEmployeeId` returns.
//
// This exists because `salary_structures` holds exactly one row per employee,
// overwritten on every change, with no effective dates — so `computeSlip` has
// no way to ask "what was this person earning in July". Re-running July after a
// raise therefore recomputed it at the *new* salary: measured on a ₹50,000
// employee raised to ₹60,000, a re-run of a full month paid ₹10,000 too much,
// and even a pro-rated exit month was out by ₹3,225.81.
//
// The fix needs no schema change because the slip already carries the whole
// basis — basic_pay, hra, both PF figures, esic, special_allowance and
// income_tax are all slip columns, snapshotted when it was generated, and a
// voided slip keeps them. So the salary that applied to a period is on record
// for any period that has ever been run.
//
// The rule this establishes, and the reason it is easy to reason about later:
// **a correction recomputes days, never salary.** Every re-run in this app
// exists to fix a day count — a late leave approval, a leaving date, a stale
// pro-ration — so keeping the salary basis fixed is what those corrections
// actually mean.
//
// The deliberate limitation: a genuinely backdated raise cannot be applied to a
// period that has already been run, because this will keep using the archived
// basis. That needs `effective_from` on the structure itself, which is a
// migration and an HR field, and is the right answer only once backdated raises
// are a real workflow.
function salaryBasisFromSlip(slip) {
    return {
        basic_salary: slip.basic_pay,
        hra: slip.hra,
        pf_employee_contribution: slip.pf_employee_contribution,
        pf_employer_contribution: slip.pf_employer_contribution,
        esic: slip.esic,
        special_allowance: slip.special_allowance,
        income_tax: slip.income_tax,
    };
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

// "YYYY-MM" -> the calendar month's [startDate, endDate] and day count,
// used both for the LOP overlap query and the per-day rate.
function monthRange(payPeriod) {
    const [year, month] = payPeriod.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const pad = (n) => String(n).padStart(2, "0");
    return {
        startDate: `${payPeriod}-01`,
        endDate: `${payPeriod}-${pad(daysInMonth)}`,
        daysInMonth,
    };
}

// "YYYY-MM-DD" for the server's local today — compared lexicographically
// against a period's endDate (same zero-padded shape), so string comparison
// alone tells us whether the period has fully ended yet.
function todayDateString() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// A period that hasn't fully ended yet has incomplete attendance/leave data
// -- a mid-month run would compute a full month's figures against a partial
// month's leave history, silently understating LOP for days that haven't
// happened yet. Payroll can therefore only be run for a pay period that has
// already finished (its last day is strictly before today). This replaces
// an earlier, deliberately looser rule that allowed a mid-month preview --
// reversed on direct request: HR wants "August's numbers in September,"
// never "September's numbers while September is still running."
function assertPeriodCompleted(payPeriod) {
    const { endDate } = monthRange(payPeriod);
    if (endDate >= todayDateString()) {
        throw badRequest("Cannot run payroll for a pay period that hasn't fully ended yet");
    }
}

// Days between two "YYYY-MM-DD" strings, inclusive of both ends -- used to
// count how many of the period's days an employee who joined partway
// through actually worked.
function inclusiveDayCount(fromDate, toDate) {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    return Math.round((new Date(toDate) - new Date(fromDate)) / MS_PER_DAY) + 1;
}

// Input: one employee's current salary_structures row and the pay period.
// Output: the full computed slip figures. Per-day rate = (basic + hra +
// special allowance) / calendar days in the month -- the divisor always
// stays the full month, even for someone who joined partway through it (per
// direct decision); only the number of payable days shrinks. PF employer
// contribution is recorded but never subtracted from net pay (it's a
// company cost, not a deduction from what the employee receives). PF/ESIC/
// income tax are flat configured amounts, not rates, so they are never
// pro-rated -- only the earnings component (basic + hra + special
// allowance) is, exactly like LOP already only ever reduced earnings.
async function computeSlip(employee, structure, payPeriod) {
    const { startDate, endDate, daysInMonth } = monthRange(payPeriod);

    // An employee who joined partway through this period was only ever
    // "employed" for the period from their joining date onward -- leave
    // taken before they joined can't exist, so the LOP/total-leave queries
    // are clamped to the same effective start, and the payable-day count
    // shrinks to match. joining_date is nullable (pre-existing data), so a
    // missing value means "no restriction" -- treat as always employed.
    const effectiveStart =
        employee.joining_date && employee.joining_date > startDate ? employee.joining_date : startDate;

    // The mirror image, and it was missing: someone who left partway through
    // the period was only employed up to their last working day, so the period
    // end is clamped exactly as the start is. Without this an employee leaving
    // on the 10th of a 31-day month was paid the full month — on a ₹50,000
    // salary that is ₹33,870.97 they did not earn, and it happens the first
    // time anyone resigns mid-month. last_working_day is nullable (it is only
    // set when someone actually leaves), so a missing value means "still
    // employed" — the same convention joining_date uses.
    const effectiveEnd =
        employee.last_working_day && employee.last_working_day < endDate ? employee.last_working_day : endDate;
    const daysEmployedInPeriod = inclusiveDayCount(effectiveStart, effectiveEnd);

    // Both leave queries are clamped to the employed window, not just its
    // start: leave dated after someone left can no more exist than leave dated
    // before they joined, and counting it would deduct LOP days from a period
    // they were not being paid for anyway.
    const [lopDays, totalLeaveDays] = await Promise.all([
        findLopWorkingDays(employee.id, effectiveStart, effectiveEnd),
        findTotalLeaveWorkingDays(employee.id, effectiveStart, effectiveEnd),
    ]);

    const basicSalary = Number(structure.basic_salary);
    const hra = Number(structure.hra);
    const specialAllowance = Number(structure.special_allowance);
    const pfEmployeeContribution = Number(structure.pf_employee_contribution);
    const pfEmployerContribution = Number(structure.pf_employer_contribution);
    const esic = Number(structure.esic);
    const incomeTax = Number(structure.income_tax);

    const perDayRate = (basicSalary + hra + specialAllowance) / daysInMonth;
    const payableDays = daysEmployedInPeriod - lopDays;
    const lopDeduction = round2(perDayRate * lopDays);
    // Days in this period the employee was not employed for -- before they
    // joined, after they left, or both -- deducted the same way LOP is (all of
    // these just mean "not paid for this day"), but tracked separately from
    // lopDeduction since none of them are leave. Zero for anyone employed for
    // the whole period, which keeps this identical to the original
    // non-prorated formula in that case.
    const notEmployedDeduction = round2(perDayRate * (daysInMonth - daysEmployedInPeriod));
    const netPay = round2(
        basicSalary +
            hra +
            specialAllowance -
            pfEmployeeContribution -
            esic -
            incomeTax -
            lopDeduction -
            notEmployedDeduction
    );

    // Nothing payable means nothing to issue. This happens for real — an
    // employee on unpaid leave for the whole month, or one whose configured
    // deductions (PF + ESIC + income tax) meet or exceed their earnings —
    // and a zero-value payslip is worse than no payslip: it looks to the
    // employee like a payment of ₹0 was made, and it occupies the
    // (employee, pay_period) slot, so the corrected run later has to be
    // voided first. Reported as a skip with the figures still attached, so
    // HR can see *why* it came to zero (the LOP days and net pay columns are
    // right there) instead of just being told it was skipped.
    //
    // `<= 0` rather than `=== 0`: a negative net pay is the same "don't
    // issue this" case, and rounding means an exact 0 isn't guaranteed.
    const isNothingPayable = netPay <= 0;

    return {
        employeeId: employee.id,
        employeeName: `${employee.first_name} ${employee.last_name}`,
        status: isNothingPayable ? "skipped" : "ok",
        skipReason: isNothingPayable
            ? "Net pay works out to zero or less — check the salary structure and this period's unpaid leave"
            : null,
        computed: {
            basicPay: basicSalary,
            hra,
            pfEmployeeContribution,
            pfEmployerContribution,
            esic,
            specialAllowance,
            lopDays,
            lopDeduction,
            totalLeaveDays,
            payableDays,
            incomeTax,
            netPay,
        },
    };
}

// Shared by calculatePayroll and confirmPayroll: every payroll-ready
// employee in the acting HR-tier actor's scope gets a computed row (an
// HR_ADMIN's own subtree, or SUPER_ADMIN's direct-report HR_ADMINs only —
// see hrScopeService.js); anyone missing a VERIFIED profile or a salary
// structure is reported as skipped, never silently omitted. `role`/
// `profileStatus` (both optional) narrow that scope first — e.g. running
// payroll for just VERIFIED employees, or just one role — so a run for the
// wrong slice of the team never has to happen in the first place. These are
// pre-filters on *who's included*, separate from the "skipped" reasons below
// (which explain why an *included* person still didn't get a real row).
async function calculateForSubtree(actor, payPeriod, { role, profileStatus } = {}) {
    const { startDate: startDateOfPeriod, endDate } = monthRange(payPeriod);
    let employees = await getHrScopedUsers(actor);
    if (role) {
        employees = employees.filter((person) => person.role === role);
    }
    if (profileStatus) {
        employees = employees.filter((person) => person.profile_status === profileStatus);
    }

    // Who already holds a live slip for this period. Resolved up front, in
    // one query for the whole batch, so the *preview* can say "already
    // received" — this used to be discovered only at confirm time, which
    // meant HR read "Ready" for someone who was then silently skipped on
    // approve. A VOIDED slip deliberately doesn't count: voiding is how a
    // period is reopened for a corrected run (see confirmPayroll).
    const existingSlips = await findSlipsByEmployeeIds(
        employees.map((person) => person.id),
        { payPeriod }
    );
    const alreadyGenerated = new Set(
        existingSlips.filter((slip) => slip.status === "ACTIVE").map((slip) => slip.employee_id)
    );

    // Every prior slip for this period, *including voided ones* — the same query
    // that answers "already generated?" also answers "what salary applied to
    // this period?". A voided slip is exactly the interesting case: void and
    // re-run is how every correction in this app happens, so that row holds the
    // basis the corrected slip should keep.
    const priorSlipByEmployee = new Map(existingSlips.map((slip) => [slip.employee_id, slip]));

    const rows = await Promise.all(
        employees.map(async (employee) => {
            if (employee.profile_status !== "VERIFIED") {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "skipped",
                    skipReason: "Profile not yet verified",
                    computed: null,
                };
            }

            // Deactivation is the action HR already takes when someone leaves,
            // and payroll used to ignore it entirely -- findSubtreeUsers walks
            // the tree with no status filter, so an INACTIVE employee with a
            // verified profile and a salary structure kept receiving a full
            // payslip, emailed to them, every month indefinitely. Reported
            // separately from the exit-date skip below because the two mean
            // different things to HR: this one is an account that was switched
            // off, that one is an employment end date on record.
            if (employee.status !== "ACTIVE") {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "skipped",
                    skipReason: "Account is no longer active",
                    computed: null,
                };
            }

            // The counterpart to "Not yet joined for this period" below: a
            // period entirely after the employee's last working day is time
            // they were not employed for at all, so there is nothing to
            // compute. Without this, setting a last working day would prorate
            // the exit month correctly and then keep issuing full payslips for
            // every month after it.
            if (employee.last_working_day && employee.last_working_day < startDateOfPeriod) {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "skipped",
                    skipReason: "Already left before this period",
                    computed: null,
                };
            }

            // A period entirely before this employee even joined has
            // nothing to compute -- skip it the same way an unverified
            // profile or missing salary structure is skipped, rather than
            // producing a slip for time they were never employed.
            if (employee.joining_date && employee.joining_date > endDate) {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "skipped",
                    skipReason: "Not yet joined for this period",
                    computed: null,
                };
            }

            // Checked before the structure lookup and the computation:
            // someone who already has a slip for this period needs neither,
            // and re-deriving figures that can't be committed anyway would
            // only invite the question of why they differ from the slip
            // they'll actually keep. `computed: null` for the same reason —
            // the row's numbers would not be the numbers on their payslip.
            if (alreadyGenerated.has(employee.id)) {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "already_generated",
                    skipReason: ALREADY_GENERATED_REASON,
                    computed: null,
                };
            }

            const structure = await findStructureByEmployeeId(employee.id);
            if (!structure) {
                return {
                    employeeId: employee.id,
                    employeeName: `${employee.first_name} ${employee.last_name}`,
                    status: "skipped",
                    skipReason: "No salary structure assigned",
                    computed: null,
                };
            }

            // A period that has been run before keeps the salary it was run
            // with; only the day-derived figures are recomputed. See
            // salaryBasisFromSlip for why, and for what this deliberately
            // cannot do (apply a backdated raise to an already-run month).
            //
            // A current structure is still required even when the basis comes
            // from the slip: its *existence* is what marks someone as on
            // payroll at all, and an employee whose structure was removed
            // should stop being paid rather than keep being paid from an
            // archive. Only its values are superseded.
            const priorSlip = priorSlipByEmployee.get(employee.id);
            const basis = priorSlip ? salaryBasisFromSlip(priorSlip) : structure;

            const row = await computeSlip(employee, basis, payPeriod);

            // Flagged so HR is never surprised by a figure that ignored a raise
            // they just entered. Without this, "I gave her a raise, re-ran
            // July, and the number didn't move" looks like a bug.
            return priorSlip ? { ...row, usedArchivedSalary: true } : row;
        })
    );

    // `alreadyGenerated` is counted separately from `skipped` rather than
    // folded into it: "nothing to do here, by design" and "this one needs
    // attention" are different messages for HR, and the client badges them
    // differently. `ok + skipped + alreadyGenerated === total` always.
    const summary = {
        total: rows.length,
        ok: rows.filter((row) => row.status === "ok").length,
        skipped: rows.filter((row) => row.status === "skipped").length,
        alreadyGenerated: rows.filter((row) => row.status === "already_generated").length,
    };

    return { rows, summary };
}

// How many days of a pay period an employee was actually employed for, given
// their current joining and leaving dates.
//
// Input: the employee row and a "YYYY-MM" period. Output: a whole number of
// days, 0 when the period falls entirely outside their employment.
//
// The same clamping computeSlip applies, extracted so the "is this payslip
// still consistent with the dates?" check below can't drift from the
// calculation that produced the payslip in the first place.
function employedDaysInPeriod(employee, payPeriod) {
    const { startDate, endDate } = monthRange(payPeriod);
    const effectiveStart =
        employee.joining_date && employee.joining_date > startDate ? employee.joining_date : startDate;
    const effectiveEnd =
        employee.last_working_day && employee.last_working_day < endDate ? employee.last_working_day : endDate;

    return effectiveEnd < effectiveStart ? 0 : inclusiveDayCount(effectiveStart, effectiveEnd);
}

// Voids every issued payslip that no longer agrees with the employee's
// employment dates, and tells them why.
//
// Input: the acting HR user, the employee row (already carrying the *new*
// dates), and HR's stated reason. Output: `{ voided }` — the pay periods
// voided, for the caller to report back.
//
// **Voids rather than recomputes, and that is the whole design.** The first
// version of this replaced the exit month's figures in place, which was wrong
// twice over. It quietly changed a payslip the employee already held — so they
// would discover a pay cut by re-reading a document they had already read — and
// it only ever looked at the month containing the leaving date, so a slip an
// *earlier* leaving date had already pro-rated was never revisited. That second
// bug underpaid a real employee: their June slip stayed at 14 payable days after
// their leaving date moved to 1 July, when they had in fact worked all of June.
//
// Comparing employed *days* rather than looking at which month the date falls in
// is what fixes that. Any mismatch in either direction — too few days, too many,
// or a period the employee was never employed for at all — is inconsistent and
// gets voided. Nothing is recomputed here: HR re-runs payroll when they choose,
// and a VOIDED slip already returns the employee to `ok` in the run preview, so
// they are picked up automatically.
//
// `payable_days + lop_days` reconstructs the employed-day count the slip was
// built from, which is why the comparison uses it rather than `payable_days`
// alone — otherwise every slip with any loss-of-pay would look inconsistent.
export async function voidSlipsInconsistentWithEmploymentDates(actor, employee, reason) {
    const slips = await findSlipsByEmployeeIds([employee.id], {});
    const voided = [];

    for (const slip of slips.filter((row) => row.status === "ACTIVE")) {
        const expectedDays = employedDaysInPeriod(employee, slip.pay_period);
        const slipDays = Number(slip.payable_days) + Number(slip.lop_days);

        if (expectedDays === slipDays) {
            continue;
        }

        const explanation =
            expectedDays === 0
                ? `${reason} — the employee was not employed during this period, so this payslip no longer applies.`
                : `${reason} — employment dates changed: this period now covers ${expectedDays} employed day(s), not ${slipDays}. Voided so payroll can be re-run.`;

        const result = await voidSlip(slip.id, { voidedBy: actor.id, reason: explanation });
        if (!result) continue; // already voided by someone else in the meantime

        voided.push(slip.pay_period);
        await notifySalarySlipVoided(result, explanation, actor.id); // non-critical side effect
        emailSlipVoided(slip, explanation);
    }

    return { voided };
}

// Tells the employee by email that a payslip has been withdrawn.
//
// Input: a slip row from SLIP_COLUMNS (it carries the employee's name and
// address, so no extra lookup) and the reason recorded on the void. Output:
// none — deliberately not awaited by any caller.
//
// Fire-and-forget for the same reason confirmPayroll's payslip send is: an SMTP
// handshake must not stretch the response HR is waiting on, and a mail failure
// must not fail a void that has already been committed. Unlike the payslip
// email there is no PDF to render, because the point of the message is that the
// previous PDF no longer counts.
//
// This is the *only* email in the exit flow, and it is the one that should be
// there. An earlier version emailed the corrected payslip instead, which meant
// a departing employee received a second, quietly smaller payslip with no
// explanation. Announcing the void and saying a corrected one will follow is
// the same information without the ambush.
function emailSlipVoided(slip, reason) {
    void sendSalarySlipVoidedEmail({
        to: slip.employee_email,
        firstName: slip.employee_first_name,
        payPeriodLabel: formatPayPeriod(slip.pay_period),
        reason,
    }).catch((error) =>
        console.error(`Failed to email void notice for ${slip.employee_email} (${slip.pay_period}):`, error.message)
    );
}

export async function calculatePayroll(actor, payPeriod, filters = {}) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can calculate payroll");
    }
    assertPeriodCompleted(payPeriod);
    return calculateForSubtree(actor, payPeriod, filters);
}

// `filters` must match whatever was passed to calculatePayroll for the
// preview HR is confirming — the same role/profileStatus slice, recomputed
// fresh (never trusting client-supplied preview figures, per the file
// header note), not a company-wide run with the preview's filters ignored.
export async function confirmPayroll(actor, payPeriod, filters = {}) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can approve payroll");
    }
    assertPeriodCompleted(payPeriod);

    const { rows } = await calculateForSubtree(actor, payPeriod, filters);
    let okRows = rows.filter((row) => row.status === "ok");
    // Everything that isn't committable is reported back, whatever its
    // reason — `!== "ok"` rather than `=== "skipped"`, so the
    // already-received and nothing-payable rows can't silently vanish from
    // the response the way they would under an exact-match filter.
    const skipped = rows.filter((row) => row.status !== "ok");

    // Re-running an already-ACTIVE period must go through voidSalarySlip
    // first — confirming again silently (replaceSlipsForPeriod's own
    // ON CONFLICT would otherwise just overwrite it) would erase a live
    // payslip without HR ever making that an explicit, reasoned decision.
    // A period whose only existing slip is VOIDED is untouched here: that
    // employee's row stays in okRows and replaceSlipsForPeriod both
    // archives the voided figures and reactivates it, exactly as before.
    //
    // calculateForSubtree now tags those rows `already_generated` itself, so
    // in practice they never reach okRows and this block finds nothing. It
    // stays as the narrow-race backstop it always implicitly was: two HR
    // admins confirming the same period concurrently both compute their rows
    // before either commits, and this is the later of the two checks.
    if (okRows.length > 0) {
        const existing = await findSlipsByEmployeeIds(
            okRows.map((row) => row.employeeId),
            { payPeriod }
        );
        const alreadyActive = new Set(
            existing.filter((slip) => slip.status === "ACTIVE").map((slip) => slip.employee_id)
        );
        if (alreadyActive.size > 0) {
            for (const row of okRows) {
                if (alreadyActive.has(row.employeeId)) {
                    skipped.push({
                        employeeId: row.employeeId,
                        employeeName: row.employeeName,
                        status: "skipped",
                        skipReason: ALREADY_GENERATED_REASON,
                        computed: null,
                    });
                }
            }
            okRows = okRows.filter((row) => !alreadyActive.has(row.employeeId));
        }
    }

    let committed = [];
    if (okRows.length > 0) {
        committed = await replaceSlipsForPeriod({
            payPeriod,
            actorId: actor.id,
            rows: okRows.map((row) => ({ employeeId: row.employeeId, ...row.computed })),
        });
        // Non-critical side effect (see notifySalarySlipsGenerated) — only
        // committed rows get notified; a skipped row never got a slip.
        await notifySalarySlipsGenerated(committed, payPeriod, actor.id);
        // Fire-and-forget, and for a different reason than
        // passwordResetService's send: this one is about the response, not a
        // timing oracle. A payroll run commits up to a couple of hundred
        // slips, each of which means rendering a PDF and completing an SMTP
        // handshake (~1-3s) — awaiting that would hold HR's request open for
        // minutes and hit the proxy's timeout long before it finished, with
        // payroll already committed. The .catch is mandatory: without it a
        // failure inside the loop's own setup becomes an unhandled rejection.
        void emailCommittedPayslips(committed, payPeriod).catch((error) =>
            console.error("Payslip email dispatch failed:", error.message)
        );
    }

    return { committed, skipped };
}

// Input: the rows `replaceSlipsForPeriod` returned and the pay period.
// Output: nothing — every failure is logged, never thrown, because by the
// time this runs the payroll is committed and HR's response has already gone
// out. There is nothing left to fail into.
//
// Re-fetches the slips it just committed instead of using `committedRows`
// directly: the RETURNING list is salary_slips columns only, while both the
// PDF and the email need the employee's name/email/designation/PAN from the
// joined shape (salarySlipRepository's SLIP_COLUMNS). One query for the whole
// batch, not one per employee.
//
// Sequential on purpose. Concurrent sends would be faster but SMTP providers
// throttle per connection and Gmail cuts off around 500 recipients/day, so a
// burst of 200 parallel handshakes is the one shape most likely to get the
// whole run rejected. Each employee is independent: a bad address, an
// oversized PDF or a transient timeout drops that one email and the loop
// continues.
async function emailCommittedPayslips(committedRows, payPeriod) {
    const employeeIds = committedRows.map((row) => row.employee_id);
    if (employeeIds.length === 0) return;

    const slips = await findSlipsByEmployeeIds(employeeIds, { payPeriod });
    const payPeriodLabel = formatPayPeriod(payPeriod);
    let sent = 0;
    let failed = 0;

    for (const slip of slips) {
        try {
            const pdf = await renderPayslipPdfBuffer(slip);
            await sendSalarySlipEmail({
                to: slip.employee_email,
                firstName: slip.employee_first_name,
                payPeriodLabel,
                netPay: slip.net_pay,
                payableDays: slip.payable_days,
                lopDays: slip.lop_days,
                pdf: { filename: `payslip-${slip.pay_period}.pdf`, content: pdf },
            });
            sent += 1;
        } catch (error) {
            failed += 1;
            console.error(`Failed to email payslip for ${slip.employee_email} (${payPeriod}):`, error.message);
        }
    }

    // One summary line rather than one per success: at 200 employees the
    // per-send logs would bury everything else, and "how many landed" is the
    // only question anyone asks afterwards.
    console.log(`[payslip-email] period=${payPeriod} sent=${sent} failed=${failed}`);
}

// Output: `actor`'s own slips only — regardless of role. Previously this and
// listSalarySlipsForHr below were one function that branched purely on
// actor.role, so an HR admin's "Your slips" (GET /salary-slips/mine) took
// the same subtree path as "Your team's slips" (GET /salary-slips) and
// returned the exact same rows, which read as duplication on the page.
export async function listMySalarySlips(actor, { payPeriod } = {}) {
    return findSlipsByEmployeeIds([actor.id], { payPeriod });
}

// Output: the slips visible within the acting HR-tier actor's scope (never
// company-wide, never via findAllUsers — this app supports more than one
// HR_ADMIN, each the root of a separate branch; SUPER_ADMIN's scope is
// narrower still, direct-report HR_ADMINs only). HR-tier only — the route
// already gates this with requireRole, this is belt-and-suspenders at the
// service layer, same as calculatePayroll/confirmPayroll above. `role`
// (optional) narrows the scope by role before the `employeeId` filter (if
// any) is applied on top — same "pre-filter, don't compute-then-discard"
// shape as calculateForSubtree's own role/profileStatus filters.
export async function listSalarySlipsForHr(actor, { employeeId, payPeriod, role, limit, offset } = {}) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can view team salary slips");
    }
    let scopedUsers = await getHrScopedUsers(actor);
    if (role) {
        scopedUsers = scopedUsers.filter((person) => person.role === role);
    }
    const scopedIds = scopedUsers.map((person) => person.id);
    const employeeIds = employeeId ? scopedIds.filter((id) => id === employeeId) : scopedIds;
    // Paginated: one payroll month is 200 rows and this list spans every
    // month ever run. `{ rows, total }`, the same contract as the leave-request
    // lists. The other callers of findSlipsByEmployeeIds pass no page and are
    // unaffected.
    const [rows, total] = await Promise.all([
        findSlipsByEmployeeIds(employeeIds, { payPeriod, limit, offset }),
        countSlipsByEmployeeIds(employeeIds, { payPeriod }),
    ]);
    return { rows, total };
}

// Input: the actor and a slip id. Output: the slip, if `actor` is the
// employee it belongs to, or an HR-tier actor whose scope contains that
// employee — mirrors leaveRequestService.getLeaveRequestById's "auth
// piggybacked on the record itself" precedent. Failure mode: 404 (never
// 403) for anyone else, including a manager, so existence isn't leaked.
export async function getSalarySlipById(actor, id) {
    const slip = await findSlipById(id);
    if (!slip) {
        throw notFound("Salary slip not found");
    }

    const isOwner = actor.id === slip.employee_id;
    if (isOwner || (await isInActorsHrScope(actor, slip.employee_id))) {
        return slip;
    }

    throw notFound("Salary slip not found");
}

// Soft-deletes a slip generated by mistake (e.g. the wrong pay period) —
// HR-tier only, and only within their own scope; never the employee
// themself, unlike getSalarySlipById above, since voiding is a correction HR
// makes, not something to self-serve. 409 if it's already VOIDED, so a
// double click can't be mistaken for success.
export async function voidSalarySlip(actor, id, reason) {
    if (actor.role !== "HR_ADMIN" && actor.role !== "SUPER_ADMIN") {
        throw forbidden("Only HR can void a salary slip");
    }

    const slip = await findSlipById(id);
    if (!slip || !(await isInActorsHrScope(actor, slip.employee_id))) {
        throw notFound("Salary slip not found");
    }

    const voided = await voidSlip(id, { voidedBy: actor.id, reason });
    if (!voided) {
        throw conflict("This salary slip is already voided");
    }
    await notifySalarySlipVoided(voided, reason, actor.id); // non-critical side effect
    // A void is a void from the employee's side, whether HR did it from the
    // Salary Slips page or an employment-date change forced it — so both paths
    // tell them the same way.
    emailSlipVoided(slip, reason);
    return voided;
}
