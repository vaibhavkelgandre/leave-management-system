import { verifyAuthToken } from "../utils/jwt.js";
import { AUTH_COOKIE_NAME, clearAuthCookie } from "../utils/cookies.js";
import { findAuthContextById } from "../repositories/userRepository.js";
import { unauthorized } from "../utils/appError.js";

// users.id is a UUID, and findAuthContextById passes the token's subject
// straight into `WHERE u.id = $1`. A subject that isn't a UUID therefore
// reaches Postgres as an invalid uuid literal and raises 22P02, which
// errorHandler has no branch for — so it answered 500 (and logged a stack)
// where the honest answer is "this token isn't usable". Checked here rather
// than mapped in errorHandler because 22P02 from anywhere else is a genuine
// server-side bug worth surfacing as one.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gatekeeper for every protected route: validates the session cookie, then
// re-fetches the user's role/status from the DB (rather than trusting the
// JWT payload) so a role change or account deactivation takes effect on the
// very next request instead of waiting for the token to expire or be revoked.
export async function requireAuth(req, res, next) {
    try {
        const token = req.cookies?.[AUTH_COOKIE_NAME];
        if (!token) {
            return next(unauthorized("Not authenticated"));
        }

        let payload;
        try {
            payload = verifyAuthToken(token);
        } catch {
            clearAuthCookie(res);
            return next(unauthorized("Session expired"));
        }

        if (typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) {
            clearAuthCookie(res);
            return next(unauthorized("Not authenticated"));
        }

        const user = await findAuthContextById(payload.sub);
        if (!user || user.status !== "ACTIVE") {
            clearAuthCookie(res);
            return next(unauthorized("Not authenticated"));
        }

        req.user = user;
        next();
    } catch (error) {
        next(error);
    }
}
