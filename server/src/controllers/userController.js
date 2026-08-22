import * as userService from "../services/userService.js";
import * as invitationService from "../services/invitationService.js";
import * as reportingService from "../services/reportingService.js";
import { sendSuccess } from "../utils/apiResponse.js";

// HR-only action to onboard a new employee/manager — there is no public registration,
// so this is how every non-HR account gets created. Re-inviting an address that
// already has a pending invite reissues its link instead of failing, so the
// message and status code follow `reissued` rather than being fixed: 200 for a
// resend (nothing was created) and 201 for a genuinely new account.
//
// Passes the whole `req.user`, not just the id: reissuing is scoped to the
// invite's creator or the caller's own HR scope, which needs their role.
export async function inviteEmployee(req, res, next) {
    try {
        const result = await invitationService.inviteEmployee(req.body, req.user);
        const status = result.reissued ? 200 : 201;
        const message = result.reissued ? "Invitation resent" : "Employee invited";
        sendSuccess(res, status, message, result);
    } catch (error) {
        next(error);
    }
}

// Lists users, scoped by the caller's role (e.g. HR sees everyone, a manager may only
// see their reports) — the actual visibility rules live in userService.
export async function getUsers(req, res, next) {
    try {
        const users = await userService.listUsersFor(req.user);
        sendSuccess(res, 200, "Users retrieved", users);
    } catch (error) {
        next(error);
    }
}

// Gives a manager the list of people who report to them, for the manager dashboard.
export async function getMyTeam(req, res, next) {
    try {
        const team = await reportingService.getTeam(req.user.id);
        sendSuccess(res, 200, "Team retrieved", userService.maskSensitiveProfileFieldsForList(team, req.user));
    } catch (error) {
        next(error);
    }
}

// Fetches a single user's profile by id, e.g. for HR/manager detail views.
// Picker-sized user list — see userService.listUserOptionsFor.
export async function getUserOptions(req, res, next) {
    try {
        const options = await userService.listUserOptionsFor(req.user);
        sendSuccess(res, 200, "User options retrieved", options);
    } catch (error) {
        next(error);
    }
}

// Count-only sibling of getMyTeam above: the dashboard's headcount chip reads
// a single number, and getMyTeam returns every subtree row with all ~40
// public columns to produce it.
export async function getMyTeamSize(req, res, next) {
    try {
        const count = await reportingService.getTeamSize(req.user.id);
        sendSuccess(res, 200, "Team size retrieved", { count });
    } catch (error) {
        next(error);
    }
}

export async function getUserById(req, res, next) {
    try {
        const user = await userService.getUserById(req.params.id, req.user);
        sendSuccess(res, 200, "User retrieved", user);
    } catch (error) {
        next(error);
    }
}

// Reassigns an employee to a different manager, keeping the reporting tree accurate as
// org structure changes.
export async function updateManager(req, res, next) {
    try {
        const user = await userService.changeManager(req.params.id, req.body.managerId, req.user);
        sendSuccess(res, 200, "Manager updated", user);
    } catch (error) {
        next(error);
    }
}

// Activates/deactivates a user account (e.g. offboarding) — passes the acting HR user
// through so the service can both record who made the change and check they're the one
// who created this account in the first place (see changeStatus).
export async function updateStatus(req, res, next) {
    try {
        const user = await userService.changeStatus(req.params.id, req.body.status, req.user);
        sendSuccess(res, 200, "Status updated", user);
    } catch (error) {
        next(error);
    }
}

// Self-service profile edit (Module 5, FR-026) — always the caller's own
// record, never masked (editing your own profile is always "self").
export async function updateMyProfile(req, res, next) {
    try {
        const user = await userService.updateMyProfile(req.user.id, req.body);
        sendSuccess(res, 200, "Profile updated", user);
    } catch (error) {
        next(error);
    }
}

// Authenticated change-password — distinct from the forgot-password reset
// flow (passwordResetService.js), which doesn't require knowing the current
// password.
export async function changePassword(req, res, next) {
    try {
        await userService.changeMyPassword(req.user.id, req.body);
        sendSuccess(res, 200, "Password changed", null);
    } catch (error) {
        next(error);
    }
}
