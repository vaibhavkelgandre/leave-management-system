// Leave balances (FR-008).
//
// A balance is never a stored, mutated number. `leave_balances` holds only the
// *entitlement* — a per-employee, per-type, per-year snapshot — while taken and
// pending days are summed from `leave_balance_ledger` every time they are read.
// That is NFR-2 in practice: the figure an employee sees cannot drift from the
// history that produced it, however long the sequence of approvals,
// cancellations and overrides.
//
// Everything here is year-scoped, and the year defaults to the current one
// rather than being required, because almost every caller means "now".
import {
    seedBalancesForUser as seedBalancesForUserRepo,
    backfillBalancesForLeaveType as backfillBalancesForLeaveTypeRepo,
    listBalancesForUser,
    updateEntitlementForYear as updateEntitlementForYearRepo,
} from "../repositories/leaveBalanceRepository.js";

const currentYear = () => new Date().getFullYear();

// Input: a user id and an optional year (defaults to the current one).
// Output: one row per leave type with entitlement, taken, pending and
// remaining. Never throws for an unknown user — an id with no rows simply
// returns [], since the caller has already been authorized to read it.
export async function getBalancesForUser(userId, year) {
    return listBalancesForUser(userId, year || currentYear());
}

// Creates this year's balance rows for one new employee, one per active leave
// type. Called when an invitation is accepted.
//
// Rows are materialised rather than derived on demand so the entitlement is
// fixed at the moment the person joined: a later change to the leave type then
// cannot silently rewrite what they were told they had.
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

// Gives every existing active employee a balance row for a newly created leave
// type.
//
// Without this a new type would be invisible until each employee happened to
// open their balances page, so HR would create "Paternity Leave" and be told by
// half the company that it doesn't exist. It is also why creating a leave type
// is a company-wide write, not a single insert.
export async function backfillBalancesForLeaveType(leaveTypeId) {
    await backfillBalancesForLeaveTypeRepo(leaveTypeId, currentYear());
}
