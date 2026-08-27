// Module 3 (FR-020): a manager nominating someone to approve on their behalf
// for a date range. `leaveRequestService.js` is what actually checks whether
// a delegation is *active* when someone tries to approve a request — this
// file only owns creating/listing delegations.
import {
    insertDelegation,
    findDelegationsForManager,
    findDelegationsForDelegate,
    findOverlappingDelegationForManager,
} from "../repositories/delegationRepository.js";
import { findUserById } from "../repositories/userRepository.js";
import { findOverlappingLeaveRequest } from "../repositories/leaveRequestRepository.js";
import { notifyDelegationNominated } from "./notificationService.js";
import { badRequest, conflict } from "../utils/appError.js";

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

// Input: the manager's id and `{ delegateId, startDate, endDate }`. Output:
// the created delegation (joined shape, includes the delegate's name).
// Failure modes: 400 if delegating to yourself or to a user that doesn't
// exist/isn't active; 409 if it overlaps a delegation this manager already
// has for an overlapping date range (avoids an ambiguous "who's the active
// delegate today"), or if the candidate delegate's own leave falls inside the
// window (see assertDelegateIsNotOnLeave).
export async function createDelegation(managerId, { delegateId, startDate, endDate }) {
    if (delegateId === managerId) {
        throw badRequest("You cannot delegate to yourself");
    }

    const delegate = await findUserById(delegateId);
    if (!delegate || delegate.status !== "ACTIVE") {
        throw badRequest("Delegate not found");
    }

    if (await findOverlappingDelegationForManager({ managerId, startDate, endDate })) {
        throw conflict("You already have a delegation covering one or more of these dates");
    }

    await assertDelegateIsNotOnLeave(delegate, { startDate, endDate });

    const delegation = await insertDelegation({ managerId, delegateId, startDate, endDate });
    await notifyDelegationNominated(delegation); // non-critical side effect
    return delegation;
}

// Output: every delegation this manager has ever nominated.
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
