// Module 3 (FR-020): a manager nominating someone to approve on their behalf
// for a date range. `leaveRequestService.js` is what actually checks whether
// a delegation is *active* when someone tries to approve a request — this
// file only owns creating/listing delegations.
import {
    insertDelegation,
    updateDelegation as updateDelegationRow,
    findDelegationById,
    findDelegationsForManager,
    findDelegationsForDelegate,
    findOverlappingDelegationForManager,
} from "../repositories/delegationRepository.js";
import { findUserById } from "../repositories/userRepository.js";
import { findOverlappingLeaveRequest } from "../repositories/leaveRequestRepository.js";
import {
    notifyDelegationNominated,
    notifyDelegationRevoked,
    notifyDelegationUpdated,
} from "./notificationService.js";
import { badRequest, conflict, notFound } from "../utils/appError.js";
import { todayDateKey } from "../utils/dates.js";

// Refuses a nomination whose window collides with the candidate delegate's own
// leave.
//
// Input: the candidate delegate's user row and the proposed window. Output:
// none. Throws 409 naming the colliding dates when they hold a live leave
// request over any part of it.
//
// Both SUBMITTED and APPROVED leave block a nomination, and the pending case is
// the one worth stating: an approved absence is obviously disqualifying, but a
// request still awaiting a decision is *this manager's own* decision to make in
// most cases, and nominating over it would leave them holding two mutually
// exclusive commitments for the same days. Treating pending as blocking also
// means the guard cannot be defeated by nominating first and approving after.
// A rejected, withdrawn or cancelled request never blocks anything —
// findOverlappingLeaveRequest already filters to the two live statuses.
//
// Dates are named in the message because this manager can already see that
// employee (a MANAGER's delegate options come from their own subtree, an
// HR-tier one's from their scope), and a refusal that will not say which dates
// collide just produces a second failed attempt.
async function assertDelegateIsNotOnLeave(delegate, { startDate, endDate }) {
    const clash = await findOverlappingLeaveRequest({ employeeId: delegate.id, startDate, endDate });
    if (!clash) {
        return;
    }

    const status = clash.status === "APPROVED" ? "approved leave" : "a pending leave request";
    throw conflict(
        `${delegate.first_name} ${delegate.last_name} has ${status} from ${clash.start_date} to ${clash.end_date}, ` +
            `which overlaps this delegation, so they cannot cover approvals then. ` +
            `Choose different dates or a different delegate.`
    );
}

// Every rule a delegation must satisfy, whether it is being created or edited.
//
// Input: the nominating manager's id, the fully-resolved window
// `{ delegateId, startDate, endDate }` (an edit merges its patch over the stored
// row before calling this, so this never sees a partial), and `excludeId` — the
// delegation being edited, which must not be compared against itself for
// overlap. Output: the delegate's user row, since callers need it and it has
// just been fetched.
//
// Failure modes: 400 delegating to yourself, to a user that does not exist or
// is not ACTIVE, or over a window that has already ended; 409 the window
// overlaps another delegation of this manager's (which would make "who is the
// active delegate today" ambiguous), or the delegate holds live leave inside
// it.
//
// Extracted so create and edit cannot drift: an edit skipping any one of these
// would be a route to a state a create refuses, which is the usual shape of
// this bug.
async function assertDelegationIsAllowed(managerId, { delegateId, startDate, endDate }, { excludeId = null } = {}) {
    if (delegateId === managerId) {
        throw badRequest("You cannot delegate to yourself");
    }

    // A window whose end date has passed can never make anyone a delegate:
    // findActiveDelegation only ever matches start_date <= today <= end_date, so
    // authority is resolved live and a wholly-past window is dead on arrival —
    // it grants nothing today and cannot grant anything later. Nobody can
    // retroactively approve a request either, since a decision is recorded with
    // the date it was actually taken. So this is rejected at the door rather
    // than stored as a row that looks like cover and is not.
    //
    // Only the *end* date is checked. A window that started in the past but has
    // not finished is ordinary in-progress coverage — a manager who forgot to
    // set it up before leaving is nominating for the days that remain, and
    // refusing that would block a real case to prevent a harmless one. This is
    // the same line the edit path draws (an ended delegation is frozen, an
    // in-progress one is not).
    if (endDate < todayDateKey()) {
        throw badRequest("A delegation cannot cover a date range that has already ended");
    }

    const delegate = await findUserById(delegateId);
    if (!delegate || delegate.status !== "ACTIVE") {
        throw badRequest("Delegate not found");
    }

    if (await findOverlappingDelegationForManager({ managerId, startDate, endDate, excludeId })) {
        throw conflict("You already have a delegation covering one or more of these dates");
    }

    await assertDelegateIsNotOnLeave(delegate, { startDate, endDate });

    return delegate;
}

// Input: the manager's id and `{ delegateId, startDate, endDate }`. Output:
// the created delegation (joined shape, includes the delegate's name).
// Failure modes: 400 if delegating to yourself or to a user that doesn't
// exist/isn't active; 409 if it overlaps a delegation this manager already
// has for an overlapping date range (avoids an ambiguous "who's the active
// delegate today"), or if the candidate delegate's own leave falls inside the
// window (see assertDelegateIsNotOnLeave).
export async function createDelegation(managerId, { delegateId, startDate, endDate }) {
    await assertDelegationIsAllowed(managerId, { delegateId, startDate, endDate });

    const delegation = await insertDelegation({ managerId, delegateId, startDate, endDate });
    await notifyDelegationNominated(delegation); // non-critical side effect
    return delegation;
}

// Input: the acting manager's id, the delegation id, and a partial
// `{ delegateId?, startDate?, endDate? }` — at least one field, enforced by the
// validator. Output: the updated delegation (joined shape).
//
// Exists because the delegate a manager picked can stop being available after
// the fact: the delegate books leave over a window that has not started yet,
// which is deliberately allowed (they never agreed to cover, and FR-020 gives
// them no way to decline) and notifies both sides with
// DELEGATION_LEAVE_CONFLICT. Before this endpoint the manager had nowhere to go
// with that notification — no edit, no revoke — so the only remedy was to let
// the window lapse with no cover at all.
//
// Failure modes: 404 if no such delegation exists **or** it belongs to another
// manager — a stranger has no more legitimate reason to learn one exists than
// to learn the id was simply wrong (NFR-5, the same call as the expired-delegate
// case); 409 if its window has already ended; 400 if the merged range inverts;
// plus every failure mode of assertDelegationIsAllowed, re-checked against the
// merged result rather than against the patch alone.
export async function updateDelegationForManager(managerId, delegationId, patch) {
    const existing = await findDelegationById(delegationId);
    if (!existing || existing.manager_id !== managerId) {
        throw notFound("Delegation not found");
    }

    // A window that has already ended is history: the delegate either acted on
    // requests during it or did not, and audit_logs records which, append-only.
    // Rewriting the nomination afterwards would contradict that trail while
    // changing nothing about who may approve anything now. An in-progress
    // window stays editable on purpose — a delegate who becomes unavailable on
    // day two of a ten-day window is exactly when a manager most needs to
    // reassign the remaining days.
    if (existing.end_date < todayDateKey()) {
        throw conflict("This delegation has already ended, so it can no longer be changed");
    }

    // DATE columns come back as "YYYY-MM-DD" strings (config/db.js's type
    // parser), so stored values merge with the patch and compare as plain
    // strings — there is no date arithmetic anywhere in here.
    const delegateId = patch.delegateId ?? existing.delegate_id;
    const startDate = patch.startDate ?? existing.start_date;
    const endDate = patch.endDate ?? existing.end_date;

    // Checked here rather than in the validator: either half of the range can
    // come from the stored row, so a body carrying only `startDate` can still
    // invert the window and the validator never sees the other value.
    if (endDate < startDate) {
        throw badRequest("endDate must be on or after startDate");
    }

    await assertDelegationIsAllowed(managerId, { delegateId, startDate, endDate }, { excludeId: delegationId });

    const delegation = await updateDelegationRow({ id: delegationId, delegateId, startDate, endDate });
    const manager = await findUserById(managerId);

    // Non-critical side effects, all of them. The outgoing delegate is told
    // first because they are the one who loses something: a swap ends their
    // coverage, and nothing else in this app would ever tell them — their
    // dashboard tile would simply stop appearing one day.
    if (delegateId !== existing.delegate_id) {
        await notifyDelegationRevoked(existing, manager);
        await notifyDelegationNominated(delegation);
    } else if (startDate !== existing.start_date || endDate !== existing.end_date) {
        await notifyDelegationUpdated(delegation, manager);
    }

    return delegation;
}

// Output: every delegation this manager has ever nominated, each carrying
// `conflict_leave_*` columns naming any live leave the nominated delegate has
// booked inside the window since being nominated — see
// findDelegationsForManager for why that can only ever be leave booked
// afterwards, and why it is answered in the same query rather than per row.
//
// Reported, never refused: this is the manager's half of the rule that lets a
// delegate book leave over a window that has not started (they never agreed to
// cover, and FR-020 gives them no way to decline). Their remedy is to edit the
// nomination, which is why the row that shows this also carries the edit action.
export async function listDelegationsForManager(managerId) {
    return findDelegationsForManager(managerId);
}

// Output: every delegation where this user is the delegate — how a delegate
// (who may be a plain EMPLOYEE, not necessarily a MANAGER themself) finds
// out they've been nominated at all, since createDelegation above never
// asks them and nothing else notifies them.
export async function listDelegationsForDelegate(delegateId) {
    return findDelegationsForDelegate(delegateId);
}
