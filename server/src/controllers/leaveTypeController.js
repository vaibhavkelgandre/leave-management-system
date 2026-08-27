// HTTP glue for leave types. One genuine decision lives here rather than in
// the service: whether the caller is allowed to see deactivated types at all
// (getLeaveTypes below). Everything else is pass-through.
import * as leaveTypeService from "../services/leaveTypeService.js";
import { sendSuccess } from "../utils/apiResponse.js";

// POST /api/leave-types — HR-tier. 201 with the created type, 409 on a
// duplicate name (compared case-insensitively).
//
// The service backfills a balance row for every active employee, so this is a
// company-wide write despite looking like a single insert.
export async function createLeaveType(req, res, next) {
    try {
        const leaveType = await leaveTypeService.createLeaveType(req.body);
        sendSuccess(res, 201, "Leave type created", leaveType);
    } catch (error) {
        next(error);
    }
}

// Inactive leave types are only surfaced to HR, regardless of what the caller
// requests, so non-HR callers never see deactivated types in list views.
export async function getLeaveTypes(req, res, next) {
    try {
        const includeInactive =
            req.query.includeInactive && (req.user.role === "HR_ADMIN" || req.user.role === "SUPER_ADMIN");
        const leaveTypes = await leaveTypeService.listLeaveTypes(includeInactive);
        sendSuccess(res, 200, "Leave types retrieved", leaveTypes);
    } catch (error) {
        next(error);
    }
}

// GET /api/leave-types/:id — any authenticated role. 404 if it doesn't exist.
export async function getLeaveTypeById(req, res, next) {
    try {
        const leaveType = await leaveTypeService.getLeaveTypeById(req.params.id);
        sendSuccess(res, 200, "Leave type retrieved", leaveType);
    } catch (error) {
        next(error);
    }
}

// PATCH /api/leave-types/:id — HR-tier. Returns `{ leaveType, balancesUpdated }`.
//
// `balancesUpdated` is 0 unless the body opts in with `applyToCurrentYear`:
// entitlement is snapshotted onto each balance row when it is created, so an
// edit changes nothing for existing employees by default. That default is
// deliberate — rewriting an entitlement changes a number people have already
// been shown — but it used to be invisible, which is why the count is
// reported rather than merely applied.
export async function updateLeaveType(req, res, next) {
    try {
        const { leaveType, balancesUpdated } = await leaveTypeService.updateLeaveType(req.params.id, req.body);
        // The count belongs in the message: HR opted in to rewriting this
        // year's entitlements, and "12 balances updated" is the confirmation
        // that it actually reached people.
        const applied = balancesUpdated ? ` ${balancesUpdated} existing balance(s) updated for this year.` : "";
        sendSuccess(res, 200, `Leave type updated.${applied}`.trim(), { leaveType, balancesUpdated });
    } catch (error) {
        next(error);
    }
}

// PATCH /api/leave-types/:id/status — HR-tier. Returns
// `{ leaveType, pendingRequests }`.
//
// Deactivating blocks *new* requests but not decisions on existing ones, so
// the count says how many are still awaiting one. Without it the type
// disappears from the picker while approvals on it keep arriving.
export async function updateLeaveTypeStatus(req, res, next) {
    try {
        const { leaveType, pendingRequests } = await leaveTypeService.setLeaveTypeStatus(
            req.params.id,
            req.body.isActive
        );
        // Deactivating blocks new requests but not decisions on existing
        // ones, so HR is told how many are still awaiting one — otherwise the
        // type vanishes from the picker while approvals on it keep landing.
        const stillPending = pendingRequests
            ? ` ${pendingRequests} request(s) of this type are still awaiting a decision and can still be approved.`
            : "";
        sendSuccess(res, 200, `Leave type status updated.${stillPending}`.trim(), { leaveType, pendingRequests });
    } catch (error) {
        next(error);
    }
}
