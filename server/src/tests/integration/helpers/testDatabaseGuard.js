// The check that stops the integration suite from running against a database
// it is allowed to destroy nothing in. Extracted from setup.js so the rule
// itself is unit-testable — the original lived inline and had a hole in it
// (see below) that no test could have caught, because a test of the guard
// would have had to spawn a whole vitest run to reach it.

// Reads a database name out of a Postgres connection string.
// Input: a connection string. Output: the database name, or `null` if the
// string can't be parsed or names no database.
//
// Deliberately returns null rather than throwing on a malformed URL: the
// caller treats "can't tell" as "refuse", which is the safe direction. Never
// returns or logs any other part of the URL — it carries a password.
function databaseNameFromUrl(connectionString) {
    try {
        const name = new URL(connectionString).pathname.replace(/^\//, "");
        return name || null;
    } catch {
        return null;
    }
}

// Throws unless `env` describes a database the integration suite may safely
// truncate. Returns nothing on success.
//
// Input: an environment object (normally `process.env`).
// Output: none. Throws `Error` with a message naming the specific problem —
// never including the connection string, which holds credentials.
//
// Three conditions, and the third is the one that was missing:
//
//  1. NODE_ENV must be "test".
//  2. DB_NAME must end in "_test".
//  3. If DATABASE_URL is set, *its* database must also end in "_test".
//
// Why 3 exists: config/db.js prefers DATABASE_URL whenever it is set and
// ignores the discrete DB_* vars entirely, while .env.test only ever defined
// DB_NAME. So a DATABASE_URL left in the shell — exactly what you set to run a
// migration against production — satisfied conditions 1 and 2 via .env.test
// and then pointed the pool at production anyway, where setup.js's beforeEach
// promptly truncated twelve tables. The guard inspected one variable and the
// pool obeyed another.
//
// Same class of leak as the blank SMTP_* entries in .env.test, and the reason
// for the same belt-and-braces treatment: .env.test now blanks DATABASE_URL
// too, but .env.test is gitignored, so this check is the half that travels
// with the repository.
export function assertTestDatabase(env) {
    if (env.NODE_ENV !== "test") {
        throw new Error(
            `Refusing to run integration tests: NODE_ENV must be 'test' (got '${env.NODE_ENV ?? "undefined"}'). Check server/.env.test.`
        );
    }

    if (!env.DB_NAME?.endsWith("_test")) {
        throw new Error(
            `Refusing to run integration tests: DB_NAME must end with '_test' (got '${env.DB_NAME ?? "undefined"}'). Check server/.env.test.`
        );
    }

    // An empty string means "not set" — .env.test blanks this deliberately.
    if (!env.DATABASE_URL) {
        return;
    }

    const urlDatabase = databaseNameFromUrl(env.DATABASE_URL);

    if (urlDatabase === null) {
        throw new Error(
            "Refusing to run integration tests: DATABASE_URL is set but its database name could not be read, so there is no way to confirm it is a test database. Unset it (PowerShell: $env:DATABASE_URL=$null)."
        );
    }

    if (!urlDatabase.endsWith("_test")) {
        throw new Error(
            `Refusing to run integration tests: DATABASE_URL points at database '${urlDatabase}', which is not a '_test' database — and config/db.js prefers DATABASE_URL over DB_NAME, so this suite would truncate that database. Unset it (PowerShell: $env:DATABASE_URL=$null).`
        );
    }
}
