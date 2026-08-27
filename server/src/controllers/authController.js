// HTTP glue for every way a session can begin or end: the one-time bootstrap,
// password and Google login, logout, accepting an invite, and password reset.
//
// The one thing worth knowing about this file is what it does *not* return.
// The JWT never reaches the response body — setAuthCookie puts it in an
// httpOnly cookie, so client JavaScript can never read it, which is what makes
// an XSS bug unable to steal a session. Callers get the user object only.
import * as authService from "../services/authService.js";
import * as invitationService from "../services/invitationService.js";
import * as passwordResetService from "../services/passwordResetService.js";
import { getUserById } from "../services/userService.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { setAuthCookie, clearAuthCookie } from "../utils/cookies.js";

// One-time bootstrap endpoint for creating the single SUPER_ADMIN account
// using the shared registration code — there is no public sign-up, so this is
// the only way into the system before any invites exist. Singleton-guarded in
// authService.registerHrRoot: a second call is rejected once one exists.
// GET /api/auth/bootstrap-status — public. Lets the signed-out login page say
// "no administrator account exists yet" and offer the one-time setup route,
// instead of a visitor facing a login form no credential can ever satisfy.
export async function getBootstrapStatus(req, res, next) {
    try {
        const status = await authService.getBootstrapStatus();
        sendSuccess(res, 200, "Bootstrap status", status);
    } catch (error) {
        next(error);
    }
}

// POST /api/auth/register/hr — public, gated by HR_REGISTRATION_CODE.
//
// Creates the single SUPER_ADMIN that owns this deployment and signs them in
// on the same response. 401 for a wrong code, 409 once one exists, 400 if the
// role row is missing (an unmigrated database). The name is historical: this
// endpoint used to create unlimited root HR admins.
export async function registerHrAdmin(req, res, next) {
    try {
        const { token, user } = await authService.registerHrRoot(req.body);
        setAuthCookie(res, token);
        sendSuccess(res, 201, "Super admin registered", { user });
    } catch (error) {
        next(error);
    }
}

// Standard email/password login for any existing user (HR_ADMIN, MANAGER, EMPLOYEE).
export async function login(req, res, next) {
    try {
        const { token, user } = await authService.loginWithPassword(req.body);
        setAuthCookie(res, token);
        sendSuccess(res, 200, "Logged in", { user });
    } catch (error) {
        next(error);
    }
}

// Alternative login method via Google OAuth — only signs in users who already have an
// account (from HR invite or HR-admin registration); it never creates new accounts.
export async function googleLogin(req, res, next) {
    try {
        const { token, user } = await authService.loginWithGoogle(req.body.idToken);
        setAuthCookie(res, token);
        sendSuccess(res, 200, "Logged in", { user });
    } catch (error) {
        next(error);
    }
}

// Ends the session by clearing the auth cookie; there's no server-side token to
// invalidate since auth is stateless JWT-in-cookie.
export async function logout(req, res) {
    clearAuthCookie(res);
    sendSuccess(res, 200, "Logged out", null);
}

// Returns the profile of whoever the auth middleware already identified from the
// request's token — used by the client to hydrate session state on load/refresh.
export async function getCurrentUser(req, res, next) {
    try {
        const user = await getUserById(req.user.id, req.user);
        sendSuccess(res, 200, "Current user", { user });
    } catch (error) {
        next(error);
    }
}

// Lets the invite-acceptance page check a token is still valid before showing the
// set-password form, without requiring the user to be authenticated yet.
export async function verifyInvitation(req, res, next) {
    try {
        const invitation = await invitationService.verifyInvitationToken(req.body.token);
        sendSuccess(res, 200, "Invitation is valid", invitation);
    } catch (error) {
        next(error);
    }
}

// Completes onboarding for an HR-invited user: sets their password and activates the
// account, then logs them in immediately so they don't have to re-authenticate.
export async function acceptInvitation(req, res, next) {
    try {
        const { token, user } = await invitationService.acceptInvitation(req.body);
        setAuthCookie(res, token);
        sendSuccess(res, 200, "Invitation accepted", { user });
    } catch (error) {
        next(error);
    }
}

// Starts the forgot-password flow. Response message is identical whether or not the
// email exists, to avoid leaking which addresses have accounts.
export async function requestPasswordReset(req, res, next) {
    try {
        await passwordResetService.requestPasswordReset(req.body.email);
        sendSuccess(res, 200, "If that email exists, a password reset link has been sent", null);
    } catch (error) {
        next(error);
    }
}

// Finishes the forgot-password flow by validating the reset token and applying the new
// password.
export async function confirmPasswordReset(req, res, next) {
    try {
        await passwordResetService.confirmPasswordReset(req.body);
        sendSuccess(res, 200, "Password reset successfully", null);
    } catch (error) {
        next(error);
    }
}
