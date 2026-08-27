// Thin HTTP glue for delegations — see leaveRequestController.js for the
// house convention this follows.
import * as delegationService from "../services/delegationService.js";
import { sendSuccess } from "../utils/apiResponse.js";

// POST /api/delegations — any authenticated role, for themselves only.
// 201 with the created delegation; 422 for an inverted date range, 400/409 for
// a delegate the service refuses (notably the caller themselves).
export async function create(req, res, next) {
    try {
        // manager_id always comes from the authenticated session — a manager
        // can only ever nominate a delegate for themselves.
        const delegation = await delegationService.createDelegation(req.user.id, req.body);
        sendSuccess(res, 201, "Delegation created", delegation);
    } catch (error) {
        next(error);
    }
}

// GET /api/delegations/mine — delegations the caller has nominated. Read-only:
// there is no revoke endpoint, so a mistake is corrected by letting the window
// pass or nominating a replacement.
export async function listMine(req, res, next) {
    try {
        const delegations = await delegationService.listDelegationsForManager(req.user.id);
        sendSuccess(res, 200, "Delegations retrieved", delegations);
    } catch (error) {
        next(error);
    }
}

// GET /api/delegations/as-delegate — delegations naming the caller as the
// delegate. Open to every role, deliberately: a delegate is often a plain
// EMPLOYEE, and this endpoint is the only way they find out they were
// nominated at all. It is also what reveals the Approvals nav link to a
// non-manager while their window is active.
export async function listAsDelegate(req, res, next) {
    try {
        const delegations = await delegationService.listDelegationsForDelegate(req.user.id);
        sendSuccess(res, 200, "Delegations retrieved", delegations);
    } catch (error) {
        next(error);
    }
}
