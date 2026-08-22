import bcrypt from "bcrypt";

// 10 in every real environment. Deliberately dropped to bcrypt's minimum
// under test, where the cost factor buys nothing: its entire purpose is to be
// slow for an attacker, and the test suite is the one caller that hashes
// hundreds of times with no adversary. Measured on this codebase: ~914 hash
// and compare calls across the integration suite at ~189ms each, or ~173s —
// about a quarter of the whole run — against ~3.6ms each at cost 4.
//
// Safe because bcrypt embeds the cost in the hash itself, so verifyPassword
// below validates a hash of any cost without being told which. Nothing asserts
// the cost factor or the hash's shape.
const SALT_ROUNDS = process.env.NODE_ENV === "test" ? 4 : 10;

// Hashes a plaintext password before storage (signup/password reset) so raw
// passwords are never persisted — bcrypt salts automatically, so identical
// passwords still produce different hashes.
export async function hashPassword(plain) {
    return bcrypt.hash(plain, SALT_ROUNDS);
}

// Checks a login attempt against the stored hash; guards against accounts
// that have no password set yet (e.g. OAuth-only users) by treating a
// missing hash as "never matches" instead of throwing.
export async function verifyPassword(plain, hash) {
    if (!hash) {
        return false;
    }
    return bcrypt.compare(plain, hash);
}
