import * as leaveTypeService from "../services/leaveTypeService.js";
import { sendSuccess } from "../utils/apiResponse.js";

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

export async function getLeaveTypeById(req, res, next) {
    try {
        const leaveType = await leaveTypeService.getLeaveTypeById(req.params.id);
        sendSuccess(res, 200, "Leave type retrieved", leaveType);
    } catch (error) {
        next(error);
    }
}

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
