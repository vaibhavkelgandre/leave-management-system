import jwt from "jsonwebtoken";

// Issues the signed session token stored in the auth cookie after
// login/OAuth; a bounded expiry (default 8h) limits how long a stolen or
// leaked token stays valid.
export function signAuthToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    });
}

// Verifies the auth cookie's signature/expiry on every authenticated
// request; throws if the token is invalid or expired, which requireAuth
// treats as "session expired".
//
// `algorithms` is pinned rather than left to jsonwebtoken's default, which for
// a string secret is the whole HMAC family — so a token signed HS384 or HS512
// with our secret was accepted, widening what counts as a valid session beyond
// the one algorithm signAuthToken above actually issues. Not exploitable
// without the secret, and the classic `alg: none` downgrade was already
// refused by the library, but the allowlist is the thing that makes "we accept
// exactly what we issue" true rather than incidental. Pinned on verify, not
// sign: verify is where an attacker-supplied header gets a vote.
export function verifyAuthToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
}
