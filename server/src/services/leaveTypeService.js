// Leave types and their lifecycle (FR-007).
//
// A leave type is global: creating one touches every active employee, and
// changing one can change numbers people have already been shown. Both of the
// mutating functions below therefore return a *count* alongside the row, so
// the caller can tell HR what actually happened rather than just "saved".
import {
    insertLeaveType,
    findAllLeaveTypes,
    findLeaveTypeById,
    updateLeaveType as updateLeaveTypeRepo,
    updateLeaveTypeStatus as updateLeaveTypeStatusRepo,
} from "../repositories/leaveTypeRepository.js";
import { countSubmittedRequestsForLeaveType } from "../repositories/leaveRequestRepository.js";
import * as leaveBalanceService from "./leaveBalanceService.js";
import { notFound } from "../utils/appError.js";

// Input: a validated leave-type definition. Output: the created row.
// Throws 409 (via the repository's unique constraint on lower(name)) for a
// duplicate name.
export async function createLeaveType(payload) {
    const leaveType = await insertLeaveType(payload);
    // Extend the new leave type to every existing active employee right away
    // instead of waiting for each of them to first read their balances.
    await leaveBalanceService.backfillBalancesForLeaveType(leaveType.id);
    return leaveType;
}

// Input: whether to include deactivated types — a decision the controller
// makes from the caller's role, not this function. Output: every matching
// type. Unpaginated: the list is bounded by how many types an org defines.
export async function listLeaveTypes(includeInactive) {
    return findAllLeaveTypes({ includeInactive });
}

// Input: a leave type id. Output: the row. Throws 404 if it doesn't exist.
//
// Used as a guard by both mutating functions below, so "does it exist" is
// answered once and in one place.
export async function getLeaveTypeById(id) {
    const leaveType = await findLeaveTypeById(id);
    if (!leaveType) {
        throw notFound("Leave type not found");
    }
    return leaveType;
}

// Input: a leave type id, its new definition, and `applyToCurrentYear` — a
// deliberate opt-in, defaulting to false. Output:
// `{ leaveType, balancesUpdated }`.
//
// `leave_balances.entitlement` is a snapshot taken when the row is created, so
// editing the type changes nothing for anyone who already has a row. That
// snapshot is right — retroactively rewriting an entitlement changes what people
// have already been shown — but the *consequence* used to be silent and
// surprising: HR raised Annual Leave from 12 to 15 in June expecting everyone to
// benefit, and instead employees hired in January kept 12 all year while anyone
// hired in July got 15. Same type, same year, two entitlements, nobody told.
//
// So the choice is now explicit rather than guessed, and it defaults to the old
// behaviour so no existing expectation changes by surprise. Applying it can take
// someone's remaining balance negative if they have already used more than the
// new entitlement — that is a real consequence of HR's choice, reported back as
// a count rather than silently prevented.
export async function updateLeaveType(id, { applyToCurrentYear = false, ...payload }) {
    await getLeaveTypeById(id);
    const updated = await updateLeaveTypeRepo(id, payload);
    if (!updated) {
        throw notFound("Leave type not found");
    }

    const balancesUpdated = applyToCurrentYear
        ? await leaveBalanceService.applyEntitlementToCurrentYear(id, updated.annual_entitlement)
        : 0;

    return { leaveType: updated, balancesUpdated };
}

// Input: a leave type id and the desired active flag. Output:
// `{ leaveType, pendingRequests }` — the count is only ever non-zero when
// deactivating.
//
// Deactivating does not cancel anything: submitLeaveRequest refuses an inactive
// type, so no *new* requests can be raised, but a request already SUBMITTED can
// still be approved (it was raised legitimately) and its days still leave the
// balance. HR is told how many are in that state, because otherwise a type
// disappears from the picker while decisions on it keep landing.
export async function setLeaveTypeStatus(id, isActive) {
    await getLeaveTypeById(id);
    const updated = await updateLeaveTypeStatusRepo(id, isActive);
    if (!updated) {
        throw notFound("Leave type not found");
    }

    const pendingRequests = isActive ? 0 : await countSubmittedRequestsForLeaveType(id);
    return { leaveType: updated, pendingRequests };
}
