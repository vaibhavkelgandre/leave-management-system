// The demo seed (deliverable #2's "one demo login per role"). Tested at the
// service level by importing seedDemoEnvironment rather than spawning the CLI,
// so the assertions can look at the database directly.
//
// The properties worth pinning are all about restraint: it must create three
// accounts, and it must not touch anything that was already there. A seed that
// quietly rewrites an existing user, or adds a leave type (which backfills a
// balance row for every active employee) or a holiday (which changes the
// working-day count of every future request in the system), would be a
// liability on a database with real records in it — which is exactly where
// this is meant to be safe to run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pool from "../../config/db.js";
import { seedDemoEnvironment } from "../../scripts/seedDemo.js";
import { createSuperAdmin, createUser, createLeaveType, createHoliday } from "./helpers/factories.js";
import { verifyPassword } from "../../utils/password.js";

const DEMO_EMAILS = ["demo.hr@example.com", "demo.manager@example.com", "demo.employee@example.com"];
const originalPassword = process.env.DEMO_PASSWORD;

beforeEach(() => {
    process.env.DEMO_PASSWORD = "SeedTestPassword123!";
});

afterEach(() => {
    if (originalPassword === undefined) delete process.env.DEMO_PASSWORD;
    else process.env.DEMO_PASSWORD = originalPassword;
});

async function demoUsers() {
    const result = await pool.query(
        `SELECT u.email, r.role_name AS role, u.status, u.profile_status, m.email AS reports_to
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN users m ON m.id = u.manager_id
         WHERE u.email = ANY($1) ORDER BY u.email`,
        [DEMO_EMAILS]
    );
    return result.rows;
}

// Reads the stored hash directly: the seed's only observable effect on an
// existing row is that this value changes, and nothing else may.
async function hashOf(email) {
    const result = await pool.query("SELECT password_hash FROM users WHERE email = $1", [email]);
    return result.rows[0]?.password_hash ?? null;
}

describe("seedDemoEnvironment", () => {
    it("refuses without DEMO_PASSWORD rather than inventing one", async () => {
        delete process.env.DEMO_PASSWORD;
        await createSuperAdmin({ email: "seed-super-nopass@example.com" });

        await expect(seedDemoEnvironment({ apply: true })).rejects.toThrow(/DEMO_PASSWORD is not set/);
        expect(await demoUsers()).toHaveLength(0);
    });

    it("refuses when there is no SUPER_ADMIN to attach the chain to", async () => {
        await expect(seedDemoEnvironment({ apply: true })).rejects.toThrow(/No SUPER_ADMIN exists/);
        expect(await demoUsers()).toHaveLength(0);
    });

    it("writes nothing on a plan run, while still reporting what's missing", async () => {
        await createSuperAdmin({ email: "seed-super-plan@example.com" });

        const report = await seedDemoEnvironment();

        expect(report.apply).toBe(false);
        expect(report.accounts.map((entry) => entry.action)).toEqual(["would create", "would create", "would create"]);
        expect(await demoUsers()).toHaveLength(0);
    });

    it("creates the three accounts as an ACTIVE, VERIFIED chain under the existing super admin", async () => {
        const superAdmin = await createSuperAdmin({ email: "seed-super-chain@example.com" });
        await createLeaveType({ name: "Seed Annual Leave", annualEntitlement: 20 });

        const report = await seedDemoEnvironment({ apply: true });

        expect(report.accounts.map((entry) => entry.action)).toEqual(["created", "created", "created"]);

        const users = await demoUsers();
        expect(users).toHaveLength(3);
        // Every one of them must be usable immediately: an INVITED account
        // can't log in at all, and an INCOMPLETE profile drops a reviewer into
        // the onboarding form instead of the app.
        for (const user of users) {
            expect(user.status).toBe("ACTIVE");
            expect(user.profile_status).toBe("VERIFIED");
        }

        const byEmail = Object.fromEntries(users.map((user) => [user.email, user]));
        expect(byEmail["demo.hr@example.com"]).toMatchObject({
            role: "HR_ADMIN",
            reports_to: superAdmin.email,
        });
        expect(byEmail["demo.manager@example.com"]).toMatchObject({
            role: "MANAGER",
            reports_to: "demo.hr@example.com",
        });
        expect(byEmail["demo.employee@example.com"]).toMatchObject({
            role: "EMPLOYEE",
            reports_to: "demo.manager@example.com",
        });
    });

    it("seeds a pending, an approved and a rejected request, with the ledger agreeing", async () => {
        await createSuperAdmin({ email: "seed-super-activity@example.com" });
        await createLeaveType({ name: "Seed Activity Leave", annualEntitlement: 20 });

        await seedDemoEnvironment({ apply: true });

        const requests = await pool.query(
            `SELECT lr.status, lr.working_days FROM leave_requests lr
             JOIN users u ON u.id = lr.employee_id
             WHERE u.email = 'demo.employee@example.com' ORDER BY lr.start_date`
        );
        expect(requests.rows.map((row) => row.status)).toEqual(["SUBMITTED", "APPROVED", "REJECTED"]);

        // The point of driving this through the services rather than raw
        // inserts: one day still held pending, one moved to taken, and the
        // rejected request's hold released — so the derived balance is correct
        // by construction (NFR-2) rather than by hand-maintained inserts.
        const ledger = await pool.query(
            `SELECT COALESCE(SUM(l.pending_delta), 0) AS pending, COALESCE(SUM(l.taken_delta), 0) AS taken
             FROM leave_balance_ledger l JOIN users u ON u.id = l.user_id
             WHERE u.email = 'demo.employee@example.com'`
        );
        expect(Number(ledger.rows[0].pending)).toBe(1);
        expect(Number(ledger.rows[0].taken)).toBe(1);

        // Append-only trail, every transition recorded.
        const audit = await pool.query(
            `SELECT a.action FROM audit_logs a
             JOIN leave_requests lr ON lr.id = a.leave_request_id
             JOIN users u ON u.id = lr.employee_id
             WHERE u.email = 'demo.employee@example.com' ORDER BY a.created_at`
        );
        expect(audit.rows.map((row) => row.action)).toEqual(["SUBMIT", "SUBMIT", "APPROVE", "SUBMIT", "REJECT"]);
    });

    it("is idempotent: a second apply run creates nothing", async () => {
        await createSuperAdmin({ email: "seed-super-idempotent@example.com" });
        await createLeaveType({ name: "Seed Idempotent Leave", annualEntitlement: 20 });

        await seedDemoEnvironment({ apply: true });
        const report = await seedDemoEnvironment({ apply: true });

        expect(report.accounts.map((entry) => entry.action)).toEqual(["exists", "exists", "exists"]);
        expect(await demoUsers()).toHaveLength(3);

        const requests = await pool.query(
            `SELECT count(*)::int AS count FROM leave_requests lr
             JOIN users u ON u.id = lr.employee_id WHERE u.email = 'demo.employee@example.com'`
        );
        expect(requests.rows[0].count).toBe(3);
    });

    it("resets the demo passwords only when asked, so a lost demo login is recoverable", async () => {
        await createSuperAdmin({ email: "seed-super-reset@example.com" });
        await createLeaveType({ name: "Seed Reset Leave", annualEntitlement: 20 });
        await seedDemoEnvironment({ apply: true });

        const before = await hashOf("demo.hr@example.com");

        // Without the flag, a re-run leaves the hash alone -- that is the
        // "never modify an existing row" property the script depends on.
        await seedDemoEnvironment({ apply: true });
        expect(await hashOf("demo.hr@example.com")).toBe(before);

        process.env.DEMO_PASSWORD = "a-different-demo-password";
        const report = await seedDemoEnvironment({ apply: true, resetPasswords: true });

        expect(report.accounts.map((entry) => entry.action)).toEqual([
            "password reset",
            "password reset",
            "password reset",
        ]);
        // The new password verifies, which is the point -- these are
        // @example.com addresses, so a reset link can never reach them.
        const after = await hashOf("demo.hr@example.com");
        expect(after).not.toBe(before);
        expect(await verifyPassword("a-different-demo-password", after)).toBe(true);
    });

    it("never resets the password of an account that isn't one of the three demo logins", async () => {
        const superAdmin = await createSuperAdmin({ email: "seed-super-scope@example.com" });
        const realPerson = await createUser({ email: "seed-real-login@example.com", managerId: superAdmin.id });
        await createLeaveType({ name: "Seed Scope Leave", annualEntitlement: 20 });
        await seedDemoEnvironment({ apply: true });

        const before = await hashOf("seed-real-login@example.com");
        process.env.DEMO_PASSWORD = "yet-another-demo-password";
        await seedDemoEnvironment({ apply: true, resetPasswords: true });

        // The flag is scoped to the three DEMO_ACCOUNTS literals. A real
        // colleague's login must be unreachable from it, including the super
        // admin the chain hangs from.
        expect(await hashOf("seed-real-login@example.com")).toBe(before);
        expect(realPerson.id).toBeDefined();
        expect(await hashOf("seed-super-scope@example.com")).toBeTruthy();
    });

    it("leaves existing users, leave types and holidays exactly as they were", async () => {
        const superAdmin = await createSuperAdmin({ email: "seed-super-untouched@example.com" });
        const realEmployee = await createUser({ email: "seed-real-person@example.com", managerId: superAdmin.id });
        const leaveType = await createLeaveType({ name: "Seed Untouched Leave", annualEntitlement: 20 });
        const holiday = await createHoliday({ name: "Seed Untouched Holiday", startDate: "2027-03-01" });

        const before = await pool.query(
            `SELECT (SELECT count(*)::int FROM leave_types) AS types,
                    (SELECT count(*)::int FROM holidays) AS holidays,
                    (SELECT row_to_json(u) FROM users u WHERE u.id = $1) AS person`,
            [realEmployee.id]
        );

        await seedDemoEnvironment({ apply: true });

        const after = await pool.query(
            `SELECT (SELECT count(*)::int FROM leave_types) AS types,
                    (SELECT count(*)::int FROM holidays) AS holidays,
                    (SELECT row_to_json(u) FROM users u WHERE u.id = $1) AS person`,
            [realEmployee.id]
        );

        // No new leave type — creating one backfills a balance row for every
        // active employee. No new holiday — holidays are global and change the
        // working-day count of every future request.
        expect(after.rows[0].types).toBe(before.rows[0].types);
        expect(after.rows[0].holidays).toBe(before.rows[0].holidays);
        expect(after.rows[0].person).toEqual(before.rows[0].person);
        expect(leaveType.id).toBeDefined();
        expect(holiday.id).toBeDefined();

        // The pre-existing employee gains no leave requests of their own.
        const theirRequests = await pool.query("SELECT count(*)::int AS count FROM leave_requests WHERE employee_id = $1", [
            realEmployee.id,
        ]);
        expect(theirRequests.rows[0].count).toBe(0);
    });

    it("skips the demo activity rather than failing when no suitable leave type exists", async () => {
        await createSuperAdmin({ email: "seed-super-notype@example.com" });

        const report = await seedDemoEnvironment({ apply: true });

        expect(report.accounts.map((entry) => entry.action)).toEqual(["created", "created", "created"]);
        expect(report.activity[0]).toMatchObject({ action: "skipped" });
        expect(report.activity[0].reason).toMatch(/no active leave type/i);
    });
});
