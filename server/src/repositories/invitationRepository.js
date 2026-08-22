import pool from "../config/db.js";

export async function invalidateActiveForUser(userId) {
    await pool.query(
        "UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND accepted_at IS NULL",
        [userId]
    );
}

// The live (unaccepted) invitation for a user, if any.
// Input: a user id. Output: `{ id, invited_by, expires_at }` or `null` — note
// this deliberately ignores `expires_at`, so a lapsed-but-not-yet-cleaned-up
// invitation still comes back: the re-invite flow treats "expired" and "still
// valid" the same way (both get a fresh token), and the caller needs
// `invited_by` either way to decide who's allowed to reissue it.
export async function findActiveInvitationForUser(userId) {
    const result = await pool.query(
        `SELECT id, invited_by, expires_at
         FROM invitations
         WHERE user_id = $1 AND accepted_at IS NULL`,
        [userId]
    );
    return result.rows[0] || null;
}

// Replaces a user's live invitation token with a new one, in place.
// Input: a user id, the new token's hash, its expiry, and the inviter to
// record *only if no invitation row exists yet* (the edge case of an INVITED
// user whose invitation row is missing). Output: `{ id, user_id, expires_at }`.
// No failure mode beyond the usual FK violation on an unknown user id.
//
// One atomic statement against uq_invitations_active_user, the same shape (and
// for the same reasons) as issuePasswordReset: two HR admins hitting resend at
// the same moment would otherwise both pass a check-then-insert and collide on
// that partial unique index, surfacing as a 409 that means nothing to either of
// them.
//
// `invited_by` is deliberately NOT in the DO UPDATE list. It's the creator
// attribution the "creator or in-my-HR-scope" rule reads (and what
// PUBLIC_USER_COLUMNS exposes as users.invited_by), so a colleague resending a
// link must not quietly become the person who hired them.
//
// Updating in place rather than inserting a second row is also what keeps
// PUBLIC_USER_COLUMNS' invited_by subquery returning exactly one row per user.
export async function reissueActiveInvitation({ userId, tokenHash, invitedBy, expiresAt }) {
    const result = await pool.query(
        `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) WHERE accepted_at IS NULL
         DO UPDATE SET token_hash = EXCLUDED.token_hash,
                       expires_at = EXCLUDED.expires_at,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING id, user_id, expires_at`,
        [userId, tokenHash, invitedBy, expiresAt]
    );
    return result.rows[0];
}

export async function insertInvitation({ userId, tokenHash, invitedBy, expiresAt }) {
    const result = await pool.query(
        `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, user_id, expires_at`,
        [userId, tokenHash, invitedBy, expiresAt]
    );
    return result.rows[0];
}

export async function findActiveByTokenHash(tokenHash) {
    const result = await pool.query(
        `SELECT id, user_id, expires_at, accepted_at
         FROM invitations
         WHERE token_hash = $1 AND accepted_at IS NULL`,
        [tokenHash]
    );
    return result.rows[0] || null;
}

export async function markAccepted(id) {
    await pool.query(
        "UPDATE invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1",
        [id]
    );
}
