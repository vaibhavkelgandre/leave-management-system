import {
    seedBalancesForUser as seedBalancesForUserRepo,
    backfillBalancesForLeaveType as backfillBalancesForLeaveTypeRepo,
    listBalancesForUser,
    updateEntitlementForYear as updateEntitlementForYearRepo,
} from "../repositories/leaveBalanceRepository.js";

const currentYear = () => new Date().getFullYear();

export async function getBalancesForUser(userId, year) {
    return listBalancesForUser(userId, year || currentYear());
}

export async function seedBalancesForUser(userId) {
    await seedBalancesForUserRepo(userId, currentYear());
}

// Applies a changed entitlement to the current year's existing balance rows.
//
// Input: a leave type id and the new entitlement. Output: the number of rows
// changed.
//
// Deliberately current-year only: past years are a record of what people were
// entitled to then, and future years have no rows yet (they are seeded on first
// read). Called only when HR opts in on the leave-type form.
export async function applyEntitlementToCurrentYear(leaveTypeId, entitlement) {
    return updateEntitlementForYearRepo(leaveTypeId, currentYear(), entitlement);
}

export async function backfillBalancesForLeaveType(leaveTypeId) {
    await backfillBalancesForLeaveTypeRepo(leaveTypeId, currentYear());
}
