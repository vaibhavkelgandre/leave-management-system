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

// PATCH /api/delegations/:id — change who is covering, or when. Owner-only:
// the manager id comes from the session, never the body, so a manager can only
// ever edit a delegation they themselves nominated.
// 200 with the updated delegation; 404 for someone else's (or a non-existent)
// delegation; 409 for a window that has already ended, one overlapping another
// of the caller's delegations, or a delegate whose own leave falls inside it.
export async function update(req, res, next) {
    try {
        const delegation = await delegationService.updateDelegationForManager(
            req.user.id,
            req.params.id,
            req.body
        );
        sendSuccess(res, 200, "Delegation updated", delegation);
    } catch (error) {
        next(error);
    }
}

// GET /api/delegations/mine — delegations the caller has nominated. There is
// still no revoke endpoint: a nomination is corrected by editing it (PATCH
// above) or by letting the window pass.
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
