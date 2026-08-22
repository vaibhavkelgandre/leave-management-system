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
