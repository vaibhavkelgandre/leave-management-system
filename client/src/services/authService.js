import apiClient, { unwrap } from "./apiClient.js";
import { toHttpError } from "./httpError.js";

// Passes every field on the raw user row through as-is — the auth context's
// `user` is read directly by ProfilePage/ProfileForm (all the Module 5
// profile fields, `profile_status`, etc.), so trimming it down to a fixed
// allowlist here silently breaks any field added later. `role` is the one
// field actually normalized: some endpoints have historically returned it
// as a nested `{ role_name }` object rather than a plain string.
export function normalizeUser(raw) {
    if (!raw) return null;
    return {
        ...raw,
        role: raw.role?.role_name ?? raw.role_name ?? raw.role ?? null,
    };
}

// Whether this deployment still has no SUPER_ADMIN, i.e. nobody can sign in
// yet and the one-time setup route is the only way forward.
//
// Input: none. Output: `true`/`false`. Never throws — a failure here must not
// stop the sign-in form rendering, so an unreachable API or an unmigrated
// database is reported as `false` and the visitor gets the ordinary login
// page. Failing the other way would show a stranger a registration form
// because of a network blip.
export async function needsBootstrap() {
    try {
        const response = await apiClient.get("/auth/bootstrap-status", { skipAuthRedirect: true });
        return unwrap(response)?.needsBootstrap === true;
    } catch {
        return false;
    }
}

// Creates the single SUPER_ADMIN account that owns this deployment, and signs
// them in — the server sets the auth cookie on the same response.
//
// Input: the registration code from the server's environment plus the admin's
// name, email and password. Output: the normalized user. Throws an HttpError:
// 401 for a wrong code, 409 once an account already exists, 422 for a field
// the server rejected.
export async function registerSuperAdmin({ registrationCode, firstName, lastName, email, password }) {
    try {
        const response = await apiClient.post(
            "/auth/register/hr",
            { registrationCode, firstName, lastName, email, password },
            { skipAuthRedirect: true }
        );
        return normalizeUser(unwrap(response)?.user);
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function login({ email, password }) {
    try {
        const response = await apiClient.post(
            "/auth/login",
            { email, password },
            { skipAuthRedirect: true }
        );
        const data = unwrap(response);
        return normalizeUser(data?.user);
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function loginWithGoogle(idToken) {
    try {
        const response = await apiClient.post(
            "/auth/google",
            { idToken },
            { skipAuthRedirect: true }
        );
        const data = unwrap(response);
        return normalizeUser(data?.user);
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function logout() {
    await apiClient.post("/auth/logout");
}

export async function getMe() {
    const response = await apiClient.get("/auth/me", { skipAuthRedirect: true });
    const data = unwrap(response);
    return normalizeUser(data?.user);
}

export async function verifyInvitation(token) {
    try {
        const response = await apiClient.post(
            "/auth/invitations/verify",
            { token },
            { skipAuthRedirect: true }
        );
        return unwrap(response);
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function acceptInvitation({ token, password }) {
    try {
        const response = await apiClient.post(
            "/auth/invitations/accept",
            { token, password },
            { skipAuthRedirect: true }
        );
        const data = unwrap(response);
        return normalizeUser(data?.user);
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function requestPasswordReset(email) {
    try {
        await apiClient.post("/auth/password-reset/request", { email }, { skipAuthRedirect: true });
    } catch (error) {
        throw toHttpError(error);
    }
}

export async function confirmPasswordReset({ token, password }) {
    try {
        await apiClient.post(
            "/auth/password-reset/confirm",
            { token, password },
            { skipAuthRedirect: true }
        );
    } catch (error) {
        throw toHttpError(error);
    }
}
