// Forgotten-password flow: issue a single-use link, then consume it.
//
// The whole file is shaped by one guarantee — **the response must not reveal
// whether an email belongs to a real account**. That is why the send is
// fire-and-forget rather than awaited (an SMTP handshake takes ~1-3s for a real
// address and milliseconds for an unknown one, which is a timing oracle), why a
// delivery failure must never become a 5xx, and why the resend cooldown returns
// silently instead of a 429. All three are security decisions that read like
// sloppy error handling; none of them may be "tidied up".
//
// Tokens are stored only as SHA-256 hashes, so a database dump yields nothing
// usable, and the raw token is deliberately kept out of every log line.
import { findAuthByEmail, updatePasswordHash } from "../repositories/userRepository.js";
import {
    issuePasswordReset,
    findActiveByTokenHash,
    markUsed,
} from "../repositories/passwordResetRepository.js";
import { sendPasswordResetEmail } from "./mailService.js";
import { generateSecureToken, hashSecureToken } from "../utils/secureToken.js";
import { hashPassword } from "../utils/password.js";
import { unauthorized } from "../utils/appError.js";

// Keep the reset window short so a leaked/intercepted link (email, logs, etc.)
// has a small blast radius.
const RESET_TOKEN_TTL_HOURS = 1;

// This endpoint is unauthenticated and now triggers an outbound email, so
// submitting one address repeatedly is a way to mail-bomb that inbox and burn
// the daily sending quota (Gmail cuts off at ~500/day). Enforced in SQL by
// issuePasswordReset.
//
// Fifteen minutes looks aggressive but costs a legitimate user nothing, and
// the reasoning is worth recording because the obvious objection is wrong:
// an attacker hammering this can't lock the victim out of resetting, because
// every request they trigger delivers a *working* link to the victim's inbox.
// The victim always has a usable token. Meanwhile this caps abuse at ~96
// emails/day/address, and staying under RESET_TOKEN_TTL_HOURS means the
// already-sent link is still valid for the whole cooldown.
const RESEND_COOLDOWN_SECONDS = 15 * 60;

// A trailing slash would produce "...//reset-password/x", and an unset var
// would produce a literal "undefined/reset-password/x" — which, now that this
// gets emailed rather than logged, means sending a real person a dead link
// and burning their token.
function resetLinkFor(rawToken) {
    const base = (process.env.CLIENT_BASE_URL || "").replace(/\/+$/, "");
    if (!base) return null;
    return `${base}/reset-password/${rawToken}`;
}

// Kicks off the "forgot password" flow: issues a single-use reset token if the
// account exists, but is deliberately silent about whether it does.
export async function requestPasswordReset(email) {
    const user = await findAuthByEmail(email);

    // Always behave the same way whether or not the account exists, so this
    // endpoint can't be used to discover which emails are registered.
    if (!user || user.status !== "ACTIVE") {
        return;
    }

    const { rawToken, tokenHash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // null means the cooldown blocked it. Nothing was written, so the token
    // the user already has in their inbox stays valid — the whole point of
    // enforcing this at the write rather than around it. Returns silently for
    // the same reason the branch above does: a visibly different throttled
    // response would leak that the account exists.
    const issued = await issuePasswordReset({
        userId: user.id,
        tokenHash,
        expiresAt,
        cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    });
    if (!issued) {
        return;
    }

    const resetLink = resetLinkFor(rawToken);
    if (!resetLink) {
        console.error("CLIENT_BASE_URL is not set — cannot build a password reset link");
        return;
    }

    // Fire-and-forget, not awaited — and this is a security decision, not a
    // performance one. An awaited SMTP handshake takes ~1-3s for a real
    // account while an unknown address returns in milliseconds from the early
    // return above. That gap is trivially measurable from a single request
    // pair, and would hand back exactly the account-enumeration ability this
    // endpoint's uniform response exists to deny. Not awaiting keeps both
    // paths indistinguishable.
    //
    // The .catch is mandatory: without it a transport failure becomes an
    // unhandled rejection. It also can't be allowed to reject into the
    // request, for the same enumeration reason — a mail outage must not turn
    // real accounts into 500s while unknown ones still get 200s. The user
    // hits a dead end either way; the remedy is alerting on this log, not a
    // different status code. Do not "fix" this into an awaited throw.
    //
    // resetLink is deliberately absent from the log: it's a live credential.
    void sendPasswordResetEmail({ to: email, resetLink, expiresInHours: RESET_TOKEN_TTL_HOURS }).catch((error) =>
        console.error(`Failed to send password reset email to ${email}:`, error.message)
    );
}

// Completes the flow started by requestPasswordReset: validates the raw token
// sent to the user against its stored hash/expiry, then sets the new password
// and burns the token so it can't be replayed.
export async function confirmPasswordReset({ token, password }) {
    const tokenHash = hashSecureToken(token);
    const reset = await findActiveByTokenHash(tokenHash);

    if (!reset || reset.expires_at < new Date()) {
        throw unauthorized("This password reset link is invalid or has expired");
    }

    const passwordHash = await hashPassword(password);
    await updatePasswordHash(reset.user_id, passwordHash);
    await markUsed(reset.id);
}
