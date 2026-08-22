// Renders "which database am I about to touch?" as a one-line string, shared
// by every script that writes to one (the migration runner and the demo
// seeder). Extracted so the rule about never printing the password exists in
// exactly one place — two copies of that would eventually disagree, and the
// copy that disagrees is the one that leaks a credential into a terminal
// scrollback or a CI log.

// Input: none — reads process.env directly, the same way config/db.js does.
// Output: a human-readable description of the connection target. Never throws;
// an unparseable DATABASE_URL is reported as such rather than raising, because
// a script's "here's what I'm about to hit" line must never be the thing that
// fails.
//
// Read from the same env the pool did, rather than asking the pool for its
// config — DATABASE_URL and the discrete DB_* vars are two different shapes
// (see config/db.js) and only one of them is ever set.
export function describeTarget() {
    if (process.env.DATABASE_URL) {
        try {
            const url = new URL(process.env.DATABASE_URL);
            // Never print the password, which is in this URL.
            return `${url.pathname.replace(/^\//, "")} on ${url.hostname} (via DATABASE_URL)`;
        } catch {
            return "(unparseable DATABASE_URL)";
        }
    }
    return `${process.env.DB_NAME} on ${process.env.DB_HOST}:${process.env.DB_PORT}`;
}

// True when the connection looks like a managed/remote database rather than a
// local one — used to decide whether a destructive-ish script needs an extra
// explicit flag before it writes.
//
// Input: none. Output: boolean.
//
// Deliberately conservative: DATABASE_URL is how Render (and every other
// managed Postgres) is configured here, while local development uses the
// discrete DB_* vars, so its mere presence is treated as "this might be
// production". A local DATABASE_URL therefore also asks for the extra flag —
// an occasional extra keystroke, against the alternative of seeding production
// by accident.
export function looksLikeProduction() {
    return process.env.NODE_ENV === "production" || Boolean(process.env.DATABASE_URL);
}
