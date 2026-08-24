// M5: the overdue-request sweep.
//
// SUBMIT moves days into `pending` in leave_balance_ledger, and only APPROVE,
// REJECT or WITHDRAW release that hold. So a request nobody ever decides
// shrinks the employee's usable balance permanently, and nothing reports it.
// That is true independently of the payroll lock — but the lock makes it more
// reachable, since a request whose period already has a payslip can no longer
// be approved or rejected at all.
//
// The sweep notifies rather than auto-closing, so these tests assert on the
// notifications and on the deliberate *absence* of any status change.
import { describe, it, expect } from "vitest";
import pool from "../../config/db.js";
import { sweepOverdueLeaveRequests } from "../../services/notificationSweepService.js";
import { createRootHr, createUser, createLeaveType, createLeaveRequest } from "./helpers/factories.js";
import { todayDateKey, addDaysToDateKey } from "../../utils/dates.js";
import { loginAs } from "./helpers/authHelpers.js";

// Well past the 30-day threshold, and anchored to a real weekday so
// submitLeaveRequest doesn't refuse it for having no working days.
function longPastRange(daysAgo) {
    let start = addDaysToDateKey(todayDateKey(), -daysAgo);
    // Walk back to a Monday-to-Friday day; three consecutive days always
    // contain one, so at most two steps.
    const isWeekend = (key) => {
        const [y, m, d] = key.split("-").map(Number);
        const day = new Date(y, m - 1, d).getDay();
        return day === 0 || day === 6;
    };
    while (isWeekend(start)) start = addDaysToDateKey(start, -1);
    return { startDate: start, endDate: start };
}

async function notificationsFor(userId, type = "LEAVE_REQUEST_OVERDUE") {
    const result = await pool.query(
        "SELECT type, message, entity_id FROM notifications WHERE recipient_id = $1 AND type = $2",
        [userId, type]
    );
    return result.rows;
}

async function setup(prefix) {
    const hr = await createRootHr({ email: `${prefix}-hr@example.com` });
    const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: `${prefix}-mgr@example.com` });
    const employee = await createUser({ managerId: manager.id, email: `${prefix}-emp@example.com` });
    const leaveType = await createLeaveType({ name: `${prefix} Leave`, annualEntitlement: 20 });
    return { hr, manager, employee, leaveType };
}

describe("Overdue leave request sweep (M5)", () => {
    it("notifies both the manager and the employee about a long-undecided request", async () => {
        const { manager, employee, leaveType } = await setup("overdue-both");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(45),
        });

        const result = await sweepOverdueLeaveRequests();

        expect(result.notified).toBe(1);

        // The manager can decide it.
        const managerNotifications = await notificationsFor(manager.id);
        expect(managerNotifications).toHaveLength(1);
        expect(managerNotifications[0].entity_id).toBe(request.id);
        expect(managerNotifications[0].message).toMatch(/waiting \d+ days for your decision/);

        // The employee can withdraw it — and the message says so, because
        // withdrawing is what releases the pending hold.
        const employeeNotifications = await notificationsFor(employee.id, "LEAVE_REQUEST_AWAITING_DECISION");
        expect(employeeNotifications).toHaveLength(1);
        expect(employeeNotifications[0].message).toMatch(/withdraw/i);
    });

    it("leaves the request untouched — it reports, it does not decide", async () => {
        const { employee, leaveType } = await setup("overdue-untouched");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(60),
        });

        await sweepOverdueLeaveRequests();

        // Auto-closing would need an actor recorded against the decision, and
        // writing down a manager who never looked at it puts a false action in
        // an append-only audit trail. So the status must not move.
        const after = await pool.query("SELECT status, decided_by FROM leave_requests WHERE id = $1", [request.id]);
        expect(after.rows[0].status).toBe("SUBMITTED");
        expect(after.rows[0].decided_by).toBeNull();

        const audit = await pool.query("SELECT action FROM audit_logs WHERE leave_request_id = $1", [request.id]);
        expect(audit.rows.map((row) => row.action)).toEqual(["SUBMIT"]);
    });

    it("ignores a request whose leave hasn't long passed yet", async () => {
        const { manager, employee, leaveType } = await setup("overdue-recent");
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(5),
        });

        const result = await sweepOverdueLeaveRequests();

        expect(result.notified).toBe(0);
        expect(await notificationsFor(manager.id)).toHaveLength(0);
    });

    it("ignores requests that were already decided", async () => {
        const { manager, employee, leaveType } = await setup("overdue-decided");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(45),
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);

        const result = await sweepOverdueLeaveRequests();

        expect(result.notified).toBe(0);
        expect(await notificationsFor(manager.id)).toHaveLength(0);
    });

    it("does not notify twice on the same day, however often it runs", async () => {
        const { manager, employee, leaveType } = await setup("overdue-dedupe");
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(45),
        });

        // The interval is hourly and a restart re-runs it immediately, so
        // without the per-day dedupe an overdue request would notify two dozen
        // times a day, forever.
        await sweepOverdueLeaveRequests();
        await sweepOverdueLeaveRequests();
        await sweepOverdueLeaveRequests();

        expect(await notificationsFor(manager.id)).toHaveLength(1);
        expect(await notificationsFor(employee.id, "LEAVE_REQUEST_AWAITING_DECISION")).toHaveLength(1);
    });

    it("still notifies the employee when they report straight to HR and have no separate manager", async () => {
        const hr = await createRootHr({ email: "overdue-nomgr-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "overdue-nomgr-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Overdue No Manager Leave", annualEntitlement: 20 });
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(45),
        });

        await sweepOverdueLeaveRequests();

        // manager_id points at HR in this shape, so HR is the one who can
        // decide — the employee must be told either way.
        expect(await notificationsFor(hr.id)).toHaveLength(1);
        expect(await notificationsFor(employee.id, "LEAVE_REQUEST_AWAITING_DECISION")).toHaveLength(1);
    });

    it("withdrawing after the nudge returns the pending days, which is the point of it", async () => {
        const { employee, leaveType } = await setup("overdue-withdraw");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            ...longPastRange(45),
        });

        const held = await pool.query(
            "SELECT COALESCE(SUM(pending_delta), 0) AS pending FROM leave_balance_ledger WHERE user_id = $1",
            [employee.id]
        );
        expect(Number(held.rows[0].pending)).toBeGreaterThan(0);

        await sweepOverdueLeaveRequests();
        await (await loginAs(employee)).post(`/api/leave-requests/${request.id}/withdraw`).send({}).expect(200);

        const released = await pool.query(
            "SELECT COALESCE(SUM(pending_delta), 0) AS pending FROM leave_balance_ledger WHERE user_id = $1",
            [employee.id]
        );
        expect(Number(released.rows[0].pending)).toBe(0);
    });
});
