import crypto from "node:crypto";
import {
    findAuthByEmail,
    touchLastLogin,
    insertUser,
    findUserById,
    updateProfileStatus,
    existsUserWithRole,
} from "../repositories/userRepository.js";
import { findRoleByName } from "../repositories/roleRepository.js";
import {
    findByProviderSubject,
    insertOauthAccount,
} from "../repositories/oauthAccountRepository.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { signAuthToken } from "../utils/jwt.js";
import { getGoogleClient } from "../config/googleClient.js";
import { badRequest, unauthorized, forbidden, conflict } from "../utils/appError.js";

// Constant-time string comparison so checking the HR registration code doesn't leak
// timing information an attacker could use to guess it character-by-character.
function timingSafeEqualStrings(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// Verifies email/password credentials and mints a session token — the primary login
// path for users onboarded via HR invite or HR-admin registration. Rejects inactive
// (e.g. offboarded) accounts even if the password is correct.
export async function loginWithPassword({ email, password }) {
    const authUser = await findAuthByEmail(email);

    const isValid = authUser && (await verifyPassword(password, authUser.password_hash));
    if (!isValid || authUser.status !== "ACTIVE") {
        throw unauthorized("Invalid email or password");
    }

    await touchLastLogin(authUser.id);

    const token = signAuthToken({ sub: authUser.id, role: authUser.role });
    const user = await findUserById(authUser.id);
    return { token, user };
}

// Alternative login method for users who already have an account (invited by HR or
// registered as HR_ADMIN) — Google is never used to create new accounts, only to sign
// into existing ones, so an unmatched email is rejected rather than auto-registered.
// The first successful Google sign-in for a user links their Google identity so future
// logins can skip re-verifying the email match.
export async function loginWithGoogle(idToken) {
    const client = getGoogleClient();
    let payload;
    try {
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
    } catch {
        throw unauthorized("Invalid Google token");
    }

    if (!payload?.email_verified) {
        throw unauthorized("Google email is not verified");
    }

    const authUser = await findAuthByEmail(payload.email);
    if (!authUser || authUser.status !== "ACTIVE") {
        throw forbidden("No account found for this email");
    }

    const existingLink = await findByProviderSubject("GOOGLE", payload.sub);
    if (!existingLink) {
        await insertOauthAccount({
            userId: authUser.id,
            provider: "GOOGLE",
            providerUserId: payload.sub,
            providerEmail: payload.email,
        });
    }

    await touchLastLogin(authUser.id);

    const token = signAuthToken({ sub: authUser.id, role: authUser.role });
    const user = await findUserById(authUser.id);
    return { token, user };
}

// Bootstraps the single SUPER_ADMIN account using a shared secret code instead
// of an invite — this is the one path into the system that isn't gated by an
// existing user, so it exists solely to get the first admin set up. Formerly
// created an HR_ADMIN (repeatable, unlimited "root" HR admins) — repurposed
// to create SUPER_ADMIN, the true top of the reporting tree, and now
// singleton-guarded: a manager-less HR_ADMIN's own leave requests could never
// be approved/verified by anyone, which SUPER_ADMIN exists to fix, so there
// can only ever be one.
export async function registerHrRoot({ registrationCode, firstName, lastName, email, password }) {
    if (!timingSafeEqualStrings(registrationCode, process.env.HR_REGISTRATION_CODE || "")) {
        throw unauthorized("Invalid registration code");
    }

    const role = await findRoleByName("SUPER_ADMIN");
    if (!role) {
        throw badRequest("SUPER_ADMIN role is not configured");
    }

    if (await existsUserWithRole(role.id)) {
        throw conflict("A super admin account already exists");
    }

    // SUPER_ADMIN never has a manager — it's the true root of the reporting
    // tree, deliberately outside it the same way the old root HR_ADMIN was.
    const passwordHash = await hashPassword(password);
    let user;
    try {
        user = await insertUser({
            firstName,
            lastName,
            email,
            passwordHash,
            roleId: role.id,
            managerId: null,
            status: "ACTIVE",
        });
    } catch (error) {
        // uq_users_single_super_admin (migration 038) is what actually
        // guarantees the singleton: the existsUserWithRole check above is a
        // check-then-insert, so two simultaneous bootstraps can both pass it
        // before either commits, and the index rejects the second insert.
        // Answered with the same message the sequential case gives, rather
        // than letting errorHandler's generic unique-violation branch report
        // "a record with these details already exists" — which reads as an
        // email clash and tells the caller nothing about the real reason.
        if (error.code === "23505" && error.constraint === "uq_users_single_super_admin") {
            throw conflict("A super admin account already exists");
        }
        throw error;
    }

    // No one is positioned to verify SUPER_ADMIN's profile (they have no
    // manager, and the whole point of this role is that nobody sits above
    // them), so it's created already VERIFIED rather than going through the
    // normal INCOMPLETE -> SUBMITTED -> VERIFIED workflow.
    await updateProfileStatus(user.id, { status: "VERIFIED" });

    const token = signAuthToken({ sub: user.id, role: "SUPER_ADMIN" });
    return { token, user: await findUserById(user.id) };
}
