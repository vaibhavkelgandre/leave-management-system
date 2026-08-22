import dotenv from "dotenv";
import { beforeEach, afterAll } from "vitest";
import { assertTestDatabase } from "./helpers/testDatabaseGuard.js";

dotenv.config({ path: ".env.test", override: true });

// Must run before config/db.js is imported below, since importing it builds
// the pool. See testDatabaseGuard.js for what each condition is protecting
// against — in particular DATABASE_URL, which config/db.js prefers over
// DB_NAME and which this file's own beforeEach would otherwise happily
// truncate.
assertTestDatabase(process.env);

const { default: pool } = await import("../../config/db.js");

beforeEach(async () => {
    await pool.query(
        `TRUNCATE users, invitations, oauth_accounts, password_resets, leave_balances, leave_types, holidays,
                  leave_requests, leave_balance_ledger, delegations, audit_logs
         RESTART IDENTITY CASCADE`
    );
});

afterAll(async () => {
    await pool.end();
});
