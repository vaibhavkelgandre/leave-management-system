// Invitations — the only way an account other than the SUPER_ADMIN comes into
// existence (FR-003/FR-004).
//
// The link is a 256-bit random token, stored only as a SHA-256 hash and
// single-use (`accepted_at`), with a window measured in hours. That window is a
// security parameter, not a convenience setting: it is clamped in code so a
// typo in the environment can't mint a credential valid for months.
//
// The pending account exists in the database from the moment the invite is
// sent, which is why an unaccepted invitation is eventually *deleted* rather
// than merely expired — otherwise the email address stays taken forever by
// somebody who never joined.
import {
    insertUser,
    findUserById,
    findInviteeByEmail,
    setPasswordHashAndActivate,
} from "../repositories/userRepository.js";
import { findRoleByName } from "../repositories/roleRepository.js";
import {
    insertInvitation,
    findActiveInvitationForUser,
    reissueActiveInvitation,
    findActiveByTokenHash,
    markAccepted,
} from "../repositories/invitationRepository.js";
import { assertManagerAllowed } from "./reportingService.js";
import { seedBalancesForUser } from "./leaveBalanceService.js";
import { notifyTeamMemberAssigned, notifyInviteAccepted, notifyProfileCreated } from "./notificationService.js";
import { sendEmployeeInviteEmail } from "./mailService.js";
import { generateSecureToken, hashSecureToken } from "../utils/secureToken.js";
import { hashPassword } from "../utils/password.js";
import { signAuthToken } from "../utils/jwt.js";
import { isInActorsHrScope } from "./hrScopeService.js";
import { badRequest, unauthorized, conflict } from "../utils/appError.js";

// How long an invite link stays valid before the recipient must be re-invited — keeps
// stale, unused invites from being redeemable indefinitely. Once this lapses the
// account itself is removed (see deleteExpiredInvitees), so the person disappears
// from the employee list and their email is freed up for a fresh invite.
//
// Shortened from 24 hours now that the link is delivered by email rather than
// pasted to the recipient by HR: it sits in an inbox (and in whatever else has
// a copy of that inbox — a synced phone, a shared mailbox, a mail archive), so
// the window in which an intercepted copy is still redeemable is the thing
// worth shrinking. Twelve hours is deliberately not shorter than that: this
// link is the *only* way into a brand-new account and the account itself is
// deleted once the link lapses (deleteExpiredInvitees). Re-inviting the same
// address now reissues the link instead of failing (see inviteEmployee), so a
// lapsed window costs HR a click rather than re-typing the whole employee
// form — but only until deleteExpiredInvitees removes the account, after which
// the form really does have to be filled in again.
//
// Three properties do the rest of the work and are all enforced elsewhere:
// the token is stored only as a SHA-256 hash (`generateSecureToken`), it is
// single-use (`accepted_at` is stamped by `markAccepted`, and
// `findActiveByTokenHash` only matches rows where it's still null), and the
// raw link is never logged outside development.
const DEFAULT_INVITE_TTL_HOURS = 12;
const MIN_INVITE_TTL_HOURS = 1;
const MAX_INVITE_TTL_HOURS = 72;

// Read per-invite rather than captured at import time so the value is a
// deployment setting (change it, restart, done) and so tests can set it per
// case. Clamped, not trusted: an unparseable or absurd value
// (`INVITE_TOKEN_TTL_HOURS=2400`, a stray comma) would otherwise silently
// mint a hundred-day credential — the exact failure this window exists to
// prevent, arrived at by typo.
function inviteTtlHours() {
    const configured = Number(process.env.INVITE_TOKEN_TTL_HOURS);
    if (!Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_INVITE_TTL_HOURS;
    }
    return Math.min(Math.max(configured, MIN_INVITE_TTL_HOURS), MAX_INVITE_TTL_HOURS);
}

// A trailing slash would produce "...//invite/x" and an unset var a literal
// "undefined/invite/x" — the same defensive shape passwordResetService.js
// uses for its reset links, and for the same reason: now that this address is
// emailed to a real person rather than shown to the HR admin who could see it
// was wrong, a malformed link burns the token on a dead page.
function inviteLinkFor(rawToken) {
    const base = (process.env.CLIENT_BASE_URL || "").replace(/\/+$/, "");
    if (!base) return null;
    return `${base}/invite/${rawToken}`;
}

// Onboards a new employee/manager without public self-registration: HR creates the
// account up front in an INVITED (inactive) state and emails a one-time link that lets
// the recipient set their own password. This keeps account creation under HR's control
// while still letting users choose their own credentials.
//
// Output: `{ user, inviteLink, emailSent, expiresAt }`. `inviteLink` is still
// returned to HR even though the email now carries it — it's the fallback for
// an unconfigured/failed mail setup, and it leaks nothing new: the caller is
// the HR admin who just created this account and could invite them again
// anyway. `emailSent` is false when mail is unconfigured, switched off
// (config/mailFeatures.js) or the send failed, which is what tells the UI
// whether to lean on that fallback.
//
// Failure modes: 400 for an unknown role or an illegal manager assignment.
// A mail failure is deliberately *not* one of them — see the send below.
// Builds the invite link and emails it — shared by a first invite and a
// reissue so the two can't drift apart in how they deliver, log or report
// failure.
//
// Input: the recipient's address/first name/role label, the raw token, the TTL
// in hours, and the id of the HR admin acting (used only to name them in the
// email). Output: `{ inviteLink, emailSent }` — `inviteLink` is `null` when
// CLIENT_BASE_URL isn't configured, and `emailSent` is false whenever the send
// was skipped, refused or threw.
//
// Deliberately never throws: by the time this runs the account and its
// invitation row are already committed, so failing here would show HR an error
// beside an employee who *was* created, while the returned link still works.
async function deliverInvite({ to, firstName, role, rawToken, ttlHours, actorId }) {
    const inviteLink = inviteLinkFor(rawToken);

    if (process.env.NODE_ENV !== "production") {
        console.log(`Invite link for ${to}: ${inviteLink}`);
    }

    if (!inviteLink) {
        // Nothing to email and nothing HR can share, but the account and its
        // invitation row are already written — reporting that plainly beats
        // throwing and leaving a stranded INVITED user with no explanation.
        console.error("CLIENT_BASE_URL is not set — cannot build an invite link");
        return { inviteLink: null, emailSent: false };
    }

    // Awaited, unlike the password-reset send: there's no account-enumeration
    // concern here (the caller is an authenticated HR admin who already knows
    // this account exists — they just created it, or are resending to it), and
    // HR needs the answer to know whether to fall back to sharing the link by
    // hand. The mailer's own timeouts cap the wait at ~10s.
    let emailSent = false;
    try {
        const invitedBy = actorId ? await findUserById(actorId) : null;
        emailSent = await sendEmployeeInviteEmail({
            to,
            firstName,
            role,
            inviteLink,
            expiresInHours: ttlHours,
            invitedByName: invitedBy ? `${invitedBy.first_name} ${invitedBy.last_name}`.trim() : null,
        });
    } catch (error) {
        // inviteLink is deliberately absent from this log: it's a live
        // credential, and application logs are the one place it shouldn't be
        // duplicated to.
        console.error(`Failed to send invite email to ${to}:`, error.message);
    }

    return { inviteLink, emailSent };
}

// Re-sends a pending employee's invite with a fresh token, superseding the old
// one in place.
//
// Input: the existing `users` row (status INVITED) and the acting HR-tier user.
// Output: the same shape as a first invite, with `reissued: true`.
// Throws 409 if the caller isn't entitled to reissue this particular invite.
//
// Why this exists at all: the invite link is emailed, so it lands in spam, gets
// deleted, or is simply ignored — and before this, re-inviting the same address
// hit the users-email unique index and surfaced as errorHandler's generic
// "a record with these details already exists". With no resend endpoint, and
// the pending account only removed once deleteExpiredInvitees runs (12h by
// default), HR had no way to recover for the rest of the day.
//
// Deliberately reissues against the stored row *unchanged* — the name, role and
// reporting line submitted with a re-invite are ignored rather than applied.
// Editing those is a different intent with its own endpoint
// (PATCH /users/:id/manager), and silently rewriting an employee's role as a
// side effect of "send that link again" is the kind of surprise that's hard to
// notice and harder to explain. The client says so explicitly.
async function reissueInvitation(existingUser, actor) {
    const invitation = await findActiveInvitationForUser(existingUser.id);

    // Creator, or anyone whose HR scope already covers this person — the same
    // rule as changeManager/changeStatus, and for the same reason: creator-only
    // leaves an HR admin unable to act on accounts they inherited rather than
    // created. An invitation row with no recorded inviter falls back to the
    // scope check alone.
    const isCreator = Boolean(invitation?.invited_by) && invitation.invited_by === actor?.id;
    if (!isCreator && !(await isInActorsHrScope(actor, existingUser.id))) {
        // 409, not 403/404: the caller asked to create an account for an
        // address that's taken, which is exactly what a conflict is. It also
        // reveals no more than the generic unique-violation 409 it replaced —
        // that the address is in use — while saying nothing about whose branch
        // the pending invite belongs to.
        throw conflict("This email already has a pending invitation");
    }

    const user = await findUserById(existingUser.id);
    const ttlHours = inviteTtlHours();
    const { rawToken, tokenHash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    // Supersedes the previous token, so any copy of the old link is dead from
    // here on — the point of a resend is one live credential, not two.
    await reissueActiveInvitation({
        userId: user.id,
        tokenHash,
        invitedBy: actor?.id,
        expiresAt,
    });

    // No notifyTeamMemberAssigned and no seedBalancesForUser here: the manager
    // was told when the invite was first created, and the balances already
    // exist. A resend is a new link, not a new employee.
    const { inviteLink, emailSent } = await deliverInvite({
        to: user.email,
        firstName: user.first_name,
        role: user.role,
        rawToken,
        ttlHours,
        actorId: actor?.id,
    });

    return { user, inviteLink, emailSent, expiresAt, reissued: true };
}

// Input: the new person's details plus the acting HR user. Output:
// `{ user, inviteLink, emailSent, expiresAt, reissued }`.
//
// Throws 409 for an address that already has an active account, or a pending
// invite the caller isn't entitled to resend; 400/422 for a reporting line the
// hierarchy rules don't allow.
//
// Re-inviting a still-pending address **reissues** the link rather than
// failing, because that is the ordinary outcome of an emailed link — spam
// folder, deleted mail, ignored mail — and there is no separate resend
// endpoint. `reissued` tells the caller which happened so the UI can say
// "re-sent" rather than "created".
//
// `emailSent` is a real signal, not decoration: when mail is switched off or
// fails, `inviteLink` is the *only* way to onboard the person, and the UI
// promotes it accordingly. A mail failure never fails the request — the user,
// their balances and the invitation are all committed first, so throwing would
// show HR an error beside an employee who genuinely exists.
export async function inviteEmployee({ firstName, lastName, email, role, managerId }, actor) {
    // Checked before the role/manager validation below, because for a pending
    // re-invite none of those submitted values are used — see
    // reissueInvitation's note on ignoring them.
    const existing = await findInviteeByEmail(email);
    if (existing) {
        if (existing.status !== "INVITED") {
            // An active (or deactivated) account is a genuine duplicate, not a
            // resend: whoever holds this address can already sign in, or has
            // been switched off on purpose. Distinguished from the pending case
            // because HR's next step differs — find them in the employee list,
            // rather than resend a link.
            throw conflict("An account with this email already exists");
        }
        return reissueInvitation(existing, actor);
    }

    const roleRecord = await findRoleByName(role);
    if (!roleRecord) {
        throw badRequest("Unknown role");
    }

    if (managerId) {
        await assertManagerAllowed(role, managerId);
    }
    const resolvedManagerId = managerId || null;

    const user = await insertUser({
        firstName,
        lastName,
        email,
        passwordHash: null,
        roleId: roleRecord.id,
        managerId: resolvedManagerId,
        status: "INVITED",
    });

    // Every employee needs a balance for each active leave type (FR-008) as
    // soon as they exist, rather than waiting for a scheduled job.
    await seedBalancesForUser(user.id);

    // Non-critical side effect — tells the assigned manager right away,
    // rather than waiting for the invite to even be accepted (an invited-but-
    // not-yet-active account can't be notified itself, so only the manager
    // side fires here; see notifyInviteAccepted below for HR's side, which
    // fires once the account is actually active).
    if (resolvedManagerId) {
        await notifyTeamMemberAssigned(user, resolvedManagerId, actor?.id);
    }

    const ttlHours = inviteTtlHours();
    const { rawToken, tokenHash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await insertInvitation({
        userId: user.id,
        tokenHash,
        invitedBy: actor?.id,
        expiresAt,
    });

    const { inviteLink, emailSent } = await deliverInvite({
        to: email,
        firstName,
        role,
        rawToken,
        ttlHours,
        actorId: actor?.id,
    });

    return { user, inviteLink, emailSent, expiresAt, reissued: false };
}

// Checks an invite link is still valid (unexpired, not already accepted) before showing
// the recipient the accept-invitation form, without requiring them to be logged in.
export async function verifyInvitationToken(rawToken) {
    const tokenHash = hashSecureToken(rawToken);
    const invitation = await findActiveByTokenHash(tokenHash);

    if (!invitation || invitation.expires_at < new Date()) {
        throw unauthorized("This invitation link is invalid or has expired");
    }

    const user = await findUserById(invitation.user_id);
    if (!user) {
        throw unauthorized("This invitation link is invalid or has expired");
    }

    return {
        email: user.email,
        first_name: user.first_name,
        expires_at: invitation.expires_at,
    };
}

// Input: the raw token from the emailed link, and the password the new user
// chose. Output: the now-active user plus a signed session — accepting logs
// them straight in.
//
// Throws 401 for a token that is unknown, already used, or past its expiry.
// One message covers all three deliberately: distinguishing them would tell an
// attacker holding a guessed token which part they got right.
//
// The token is looked up by *hash*, never by the raw value, which is why a
// database dump cannot be turned into a working invite link.
export async function acceptInvitation({ token, password }) {
    const tokenHash = hashSecureToken(token);
    const invitation = await findActiveByTokenHash(tokenHash);

    if (!invitation || invitation.expires_at < new Date()) {
        throw unauthorized("This invitation link is invalid or has expired");
    }

    const passwordHash = await hashPassword(password);
    const user = await setPasswordHashAndActivate(invitation.user_id, passwordHash);
    await markAccepted(invitation.id);
    // Both non-critical side effects; actor is the accepting user themself
    // in each case — there's no HR actor in the loop at accept time.
    await notifyInviteAccepted(user.id, user.id);
    await notifyProfileCreated(user.id, user.id);

    const authToken = signAuthToken({ sub: user.id });
    return { token: authToken, user };
}
