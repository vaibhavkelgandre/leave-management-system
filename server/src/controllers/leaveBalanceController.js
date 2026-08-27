// HTTP glue for leave balances.
//
// Balances are never stored as a mutable number — they are summed from
// `leave_balance_ledger` at read time, so what these endpoints return always
// agrees with the history that produced it (NFR-2). Both handlers call the
// same service function; they differ only in whose id they pass.
import * as leaveBalanceService from "../services/leaveBalanceService.js";
import { sendSuccess } from "../utils/apiResponse.js";

// GET /api/leave-balances/me — any authenticated role, own balances only.
// Optional `year`, defaulting to the current one.
//
// Includes a discontinued leave type when the employee has days recorded on
// it, flagged so the client can badge it: the ledger still holds those days,
// and hiding the type would make their own history unreadable. A type they
// never used stays hidden, since a full untouched entitlement would read as
// leave they could still take.
export async function getMyBalances(req, res, next) {
    try {
        const balances = await leaveBalanceService.getBalancesForUser(req.user.id, req.query.year);
        sendSuccess(res, 200, "Balances retrieved", balances);
    } catch (error) {
        next(error);
    }
}

// GET /api/users/:id/leave-balances — the caller themselves, their manager,
// an in-scope HR admin, or SUPER_ADMIN.
//
// The scope check is the route's `requireUserScope("id")` middleware, not code
// here — which is why this handler looks identical to getMyBalances despite
// being the one that can read somebody else's numbers.
export async function getUserBalances(req, res, next) {
    try {
        const balances = await leaveBalanceService.getBalancesForUser(req.params.id, req.query.year);
        sendSuccess(res, 200, "Balances retrieved", balances);
    } catch (error) {
        next(error);
    }
}
