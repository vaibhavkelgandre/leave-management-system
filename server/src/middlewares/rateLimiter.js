// IP-level rate limiting for the pre-authentication endpoints. Everything else
// in this API is gated by a session and a row-level authorization check, but
// these routes are reachable by anyone: they accept a password, a shared
// registration secret, or a single-use token, and until now accepted them an
// unlimited number of times. bcrypt and crypto.timingSafeEqual only make each
// individual guess expensive/uninformative — they do nothing about volume.
//
// Deliberately NOT applied globally. A limiter over the whole API would be
// keyed on an IP that, for an office behind one NAT, is shared by the entire
// company — and the client polls (the notification bell and the approvals
// badge, every 30s each) on top of ordinary page loads. The endpoints below
// are the ones where a high request rate is never legitimate.
//
// The store is in-memory, so counts are per process and reset on deploy. That
// matches this deployment (a single Render web service) and is the same
// trade-off express-rate-limit's own default makes; a shared store (Redis)
// only becomes necessary once the API runs on more than one instance.
import rateLimit, { MemoryStore } from "express-rate-limit";
import { sendError } from "../utils/apiResponse.js";

const MINUTE = 60 * 1000;

// Every store this module creates. Held only so the counters can be cleared
// between tests — a limiter is stateful, so without this each test would
// inherit whatever the previous one used up. Nothing in the running app reads it.
const stores = [];

// Read per request rather than captured at import time, so the flag behaves as
// an operational switch and a test can turn limiting on for the one case that
// exercises it. Off under NODE_ENV=test by default: the integration suite makes
// hundreds of logins from a single loopback address, and a limiter that counted
// them would fail tests that have nothing to do with rate limiting.
function isRateLimitingDisabled() {
    if (process.env.RATE_LIMIT_ENABLED === "true") return false;
    if (process.env.RATE_LIMIT_ENABLED === "false") return true;
    return process.env.NODE_ENV === "test";
}

/**
 * Builds a limiter middleware over a fixed window, keyed on the caller's IP
 * (express-rate-limit's default key generator, which normalizes IPv6 to a /56
 * subnet so one client cannot cycle addresses it already owns).
 *
 * Input: { windowMs, max, message, skipSuccessfulRequests }. `max` is the number
 * of requests allowed per window; when `skipSuccessfulRequests` is true only
 * non-2xx responses are counted, which is what makes a login limit safe for a
 * shared office IP — a legitimate sign-in never consumes budget.
 * Output: an Express middleware.
 * Failure modes: over the limit it ends the request with 429 in this API's
 * standard error envelope (never `next(err)`, so it cannot be mistaken for an
 * application error); while disabled it passes every request straight through.
 */
function createRateLimiter({ windowMs, max, message, skipSuccessfulRequests = false }) {
    // Explicit instance of the store express-rate-limit would have created
    // anyway, so it can be reset by resetRateLimiters(); behaviour is identical.
    const store = new MemoryStore();
    stores.push(store);

    return rateLimit({
        windowMs,
        limit: max,
        store,
        skipSuccessfulRequests,
        skip: isRateLimitingDisabled,
        // RateLimit-* response headers; the X-RateLimit-* ones are legacy and
        // would only duplicate them.
        standardHeaders: true,
        legacyHeaders: false,
        // Same { success, message, errors } shape as every other error this API
        // returns, so the client's existing error handling needs no special case.
        handler: (req, res) => sendError(res, 429, message, []),
    });
}

// Credential guessing against POST /auth/login and POST /auth/google.
// Only failed attempts count, so the ceiling is reached by someone guessing,
// not by a busy office signing in. 20 failures in 15 minutes is well above what
// mistyping a password produces and far below what brute force needs.
export const loginRateLimiter = createRateLimiter({
    windowMs: 15 * MINUTE,
    max: 20,
    skipSuccessfulRequests: true,
    message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

// POST /auth/register/hr. Guards the shared HR_REGISTRATION_CODE, which is the
// one secret in this app that a wrong guess reveals nothing about (it is
// compared with timingSafeEqual) but that nothing else slows down. Legitimate
// use is once per deployment, so this can be tight; successes are counted too,
// since a second success is impossible anyway (the account is a singleton).
export const registrationRateLimiter = createRateLimiter({
    windowMs: 60 * MINUTE,
    max: 5,
    message: "Too many registration attempts. Please wait an hour and try again.",
});

// POST /auth/password-reset/request. Successes are counted deliberately, unlike
// login: a *successful* request is what sends an email, so the abuse this caps
// is mail-quota burn and inbox flooding across many addresses. The existing
// 15-minute cooldown in issuePasswordReset is per account and cannot see that.
// Note this endpoint answers identically for known and unknown addresses; the
// limit is on the IP, not the address, so it does not reintroduce an oracle.
export const passwordResetRateLimiter = createRateLimiter({
    windowMs: 60 * MINUTE,
    max: 10,
    message: "Too many password reset requests. Please wait an hour and try again.",
});

// The single-use-token endpoints: invitation verify/accept and password-reset
// confirm. The tokens are 256-bit, so this is not what stops them being
// guessed — it stops an unbounded stream of attempts sitting on an endpoint
// that does a database lookup per call. Failures only, so a new joiner
// reloading the accept page never runs into it.
export const tokenRateLimiter = createRateLimiter({
    windowMs: 60 * MINUTE,
    max: 30,
    skipSuccessfulRequests: true,
    message: "Too many attempts. Please wait an hour and try again.",
});

/**
 * Clears every limiter's counters. For tests only — a limiter's state outlives
 * a single test, so a suite that exercises one limit would otherwise start the
 * next test with a partly-consumed budget.
 *
 * Input: none. Output: none. Failure modes: none; a store with no entries is a
 * no-op. Never called from application code.
 */
export function resetRateLimiters() {
    for (const store of stores) store.resetAll?.();
}
