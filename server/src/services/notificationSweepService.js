// Home for time-based (not event-driven) notification triggers — every
// other notify* call in this app fires directly from the request handler
// that caused it (leaveRequestService, userService, etc.); a delegation's
// start/end date isn't anyone's action on the day itself, so there's no
// request to hook into. server.js calls sweepDelegationTransitions on a
// timer instead. Kept in its own file (rather than folded into
// delegationService.js) so this "runs on a schedule" concern stays visibly
// separate from delegationService's request-driven CRUD, and so a future
// second sweep (if one's ever needed) has an obvious home.
import { findDelegationsStartingOn, findDelegationsEndingOn } from "../repositories/delegationRepository.js";
import { findOverdueSubmittedRequests } from "../repositories/leaveRequestRepository.js";
import { notifyDelegationStarted, notifyDelegationEnded, notifyLeaveRequestOverdue } from "./notificationService.js";
import { todayDateKey, addDaysToDateKey } from "../utils/dates.js";

// Input: none — always checks against today's date. Output: none; creates a
// DELEGATION_STARTED notification for every delegation whose window begins
// today and a DELEGATION_ENDED one for every delegation whose window ends
// today. Safe to call more than once on the same calendar day (e.g. an
// hourly interval, or a server restart) — notifyDelegationStarted/Ended
// each dedupe via existsNotificationCreatedToday, so a repeat call is a no-op.
export async function sweepDelegationTransitions() {
    const today = todayDateKey();
    const [startingToday, endingToday] = await Promise.all([
        findDelegationsStartingOn(today),
        findDelegationsEndingOn(today),
    ]);

    for (const delegation of startingToday) {
        await notifyDelegationStarted(delegation);
    }
    for (const delegation of endingToday) {
        await notifyDelegationEnded(delegation);
    }
}

// How long after a leave's start date an undecided request counts as overdue.
//
// 30 days is chosen against the payroll cycle rather than as a round number:
// payroll for a period can only run once that period has fully ended, so a
// request from the 1st of a month is at most ~31 days old when its payroll
// runs. Thirty days therefore raises the alarm at roughly the point where the
// request is about to become — or has just become — undecidable because a
// payslip now covers it (see assertPeriodsOpen in leaveRequestService.js).
// Shorter would nag about requests a manager is legitimately still sitting on;
// much longer and the pending days are stuck for a whole extra cycle.
const OVERDUE_AFTER_DAYS = 30;

// Reports leave requests still SUBMITTED long after the leave itself passed.
//
// Input: none — always measured against today. Output: `{ checked, notified }`
// for the caller's log line.
//
// Why this sweep exists at all: SUBMIT moves days into `pending` in
// leave_balance_ledger, and only APPROVE, REJECT or WITHDRAW release that hold.
// A request nobody ever decides therefore reduces the employee's usable balance
// permanently, and nothing anywhere reports it. That is true independently of
// the payroll lock, but the lock makes it more reachable: once a payslip covers
// the period, the request can no longer be approved or rejected, and the
// employee's own WITHDRAW is the only remaining exit — which is exactly why the
// lock deliberately leaves WITHDRAW open.
//
// It notifies rather than auto-closing, and that is a deliberate limit rather
// than an unfinished edge. Closing a request needs an actor recorded against
// it, and writing the manager down as having rejected something they never
// looked at puts a false action in an append-only audit trail. A dedicated
// EXPIRED status would avoid that, but it changes what the employee sees and is
// a product decision, not a technical one. So the sweep hands the problem to
// the two people who have a real action available.
//
// Safe to run repeatedly: notifyLeaveRequestOverdue dedupes per calendar day,
// so the hourly interval and a server restart are both no-ops after the first
// run of the day.
export async function sweepOverdueLeaveRequests() {
    const cutoff = addDaysToDateKey(todayDateKey(), -OVERDUE_AFTER_DAYS);
    const overdue = await findOverdueSubmittedRequests(cutoff);

    for (const request of overdue) {
        const daysOverdue = daysBetween(request.start_date, todayDateKey());
        await notifyLeaveRequestOverdue(request, daysOverdue);
    }

    return { checked: overdue.length, notified: overdue.length };
}

// Whole days between two "YYYY-MM-DD" keys, for the "waiting N days" wording.
// Built from local date parts rather than Date.parse for the same timezone
// reason as everything in utils/dates.js.
function daysBetween(fromDateKey, toDateKey) {
    const [fromYear, fromMonth, fromDay] = fromDateKey.split("-").map(Number);
    const [toYear, toMonth, toDay] = toDateKey.split("-").map(Number);
    const from = new Date(fromYear, fromMonth - 1, fromDay);
    const to = new Date(toYear, toMonth - 1, toDay);
    return Math.round((to - from) / 86400000);
}
