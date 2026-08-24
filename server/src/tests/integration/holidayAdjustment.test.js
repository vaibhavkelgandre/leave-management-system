// G11: a holiday declared after a leave request was approved.
//
// `working_days` is computed once at submit and never recomputed, and the ledger
// entries that moved days into pending or taken used that stored figure. So a
// holiday declared afterwards — normal, not an edge case — left the employee
// charged for a day that had become a holiday: five days deducted for a Mon–Fri
// leave with a Wednesday holiday added later, permanently one day short.
//
// The correction is an append, not a rewrite: `working_days` is a derived cache
// and is updated in place, but the balance moves through a HOLIDAY_ADJUSTMENT
// ledger entry, which is what leave_balance_ledger is for (NFR-2 — the balance
// must agree with the history that produced it).
import { describe, it, expect } from "vitest";
import pool from "../../config/db.js";
import { createRootHr, createUser, createLeaveType, createLeaveRequest } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

// Mon 13 – Fri 17 July 2026 is five working days, with Wed 15 in the middle.
const LEAVE_START = "2026-07-13";
const LEAVE_END = "2026-07-17";
const MID_LEAVE_HOLIDAY = "2026-07-15";

async function setup(prefix) {
    const hr = await createRootHr({ email: `${prefix}-hr@example.com` });
    const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: `${prefix}-mgr@example.com` });
    const employee = await createUser({ managerId: manager.id, email: `${prefix}-emp@example.com` });
    const leaveType = await createLeaveType({ name: `${prefix} Leave`, annualEntitlement: 20 });
    return { hr, manager, employee, leaveType };
}

async function ledgerFor(employeeId) {
    const result = await pool.query(
        `SELECT reason, pending_delta, taken_delta FROM leave_balance_ledger
         WHERE user_id = $1 ORDER BY created_at`,
        [employeeId]
    );
    return result.rows;
}

async function balanceOf(employeeId) {
    const result = await pool.query(
        `SELECT COALESCE(SUM(pending_delta), 0) AS pending, COALESCE(SUM(taken_delta), 0) AS taken
         FROM leave_balance_ledger WHERE user_id = $1`,
        [employeeId]
    );
    return { pending: Number(result.rows[0].pending), taken: Number(result.rows[0].taken) };
}

describe("Holiday changes recount live leave (G11)", () => {
    it("returns a day to the balance when a holiday lands inside approved leave", async () => {
        const { hr, manager, employee, leaveType } = await setup("holadj-approved");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 5 });

        const response = await (await loginAs(hr))
            .post("/api/holidays")
            .send({ name: "Declared holiday", startDate: MID_LEAVE_HOLIDAY });

        expect(response.statusCode).toBe(201);
        // HR is told, because one holiday can move several people's balances.
        expect(response.body.data.adjusted).toHaveLength(1);
        expect(response.body.data.adjusted[0]).toMatchObject({ previousDays: 5, newDays: 4 });
        expect(response.body.message).toMatch(/1 leave request\(s\) recounted/);

        // The stored count is corrected...
        const after = await pool.query("SELECT working_days FROM leave_requests WHERE id = $1", [request.id]);
        expect(Number(after.rows[0].working_days)).toBe(4);

        // ...and the balance follows, via an append rather than an edit.
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 4 });
        const ledger = await ledgerFor(employee.id);
        expect(ledger.map((row) => row.reason)).toEqual(["SUBMIT", "APPROVE", "HOLIDAY_ADJUSTMENT"]);
        expect(Number(ledger[2].taken_delta)).toBe(-1);
    });

    it("adjusts the pending hold when the request is still awaiting a decision", async () => {
        const { hr, employee, leaveType } = await setup("holadj-pending");
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        expect(await balanceOf(employee.id)).toEqual({ pending: 5, taken: 0 });

        await (await loginAs(hr))
            .post("/api/holidays")
            .send({ name: "Declared holiday", startDate: MID_LEAVE_HOLIDAY })
            .expect(201);

        // A SUBMITTED request holds its days in `pending`; an APPROVED one has
        // moved them to `taken`. Adjusting the wrong column would corrupt the
        // balance in a way that is very hard to see.
        expect(await balanceOf(employee.id)).toEqual({ pending: 4, taken: 0 });
        const ledger = await ledgerFor(employee.id);
        expect(Number(ledger[1].pending_delta)).toBe(-1);
        expect(Number(ledger[1].taken_delta)).toBe(0);
    });

    it("takes a day back when a holiday inside approved leave is deleted", async () => {
        const { hr, manager, employee, leaveType } = await setup("holadj-deleted");
        const hrAgent = await loginAs(hr);
        const created = await hrAgent
            .post("/api/holidays")
            .send({ name: "Mistaken holiday", startDate: MID_LEAVE_HOLIDAY })
            .expect(201);

        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);
        // Submitted while the holiday existed, so it only ever cost 4 days.
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 4 });

        const response = await hrAgent.delete(`/api/holidays/${created.body.data.holiday.id}`);

        expect(response.statusCode).toBe(200);
        expect(response.body.data.adjusted[0]).toMatchObject({ previousDays: 4, newDays: 5 });
        // The under-charge is corrected in the other direction.
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 5 });
    });

    it("recounts across both the old and new dates when a holiday moves", async () => {
        const { hr, manager, employee, leaveType } = await setup("holadj-moved");
        const hrAgent = await loginAs(hr);
        const created = await hrAgent
            .post("/api/holidays")
            .send({ name: "Movable holiday", startDate: MID_LEAVE_HOLIDAY })
            .expect(201);

        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);

        // Moved right out of the leave window. Reconciling only the *new* dates
        // would miss that the old date stopped being a holiday.
        const response = await hrAgent
            .patch(`/api/holidays/${created.body.data.holiday.id}`)
            .send({ name: "Movable holiday", startDate: "2026-07-27" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.adjusted[0]).toMatchObject({ previousDays: 4, newDays: 5 });
    });

    it("leaves requests alone when the holiday falls outside them", async () => {
        const { hr, manager, employee, leaveType } = await setup("holadj-outside");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);

        const response = await (await loginAs(hr))
            .post("/api/holidays")
            .send({ name: "Unrelated holiday", startDate: "2026-09-14" });

        expect(response.body.data.adjusted).toEqual([]);
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 5 });
        expect(await ledgerFor(employee.id)).toHaveLength(2);
    });

    it("ignores requests that have already released their days", async () => {
        const { hr, employee, leaveType } = await setup("holadj-withdrawn");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(employee)).post(`/api/leave-requests/${request.id}/withdraw`).send({}).expect(200);
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 0 });

        await (await loginAs(hr))
            .post("/api/holidays")
            .send({ name: "Declared holiday", startDate: MID_LEAVE_HOLIDAY })
            .expect(201);

        // Recounting a withdrawn request would move a balance for something
        // that no longer affects one.
        expect(await balanceOf(employee.id)).toEqual({ pending: 0, taken: 0 });
        const after = await pool.query("SELECT working_days FROM leave_requests WHERE id = $1", [request.id]);
        expect(Number(after.rows[0].working_days)).toBe(5);
    });

    it("tells the employee, with both figures", async () => {
        const { hr, manager, employee, leaveType } = await setup("holadj-notify");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: LEAVE_START,
            endDate: LEAVE_END,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);

        await (await loginAs(hr))
            .post("/api/holidays")
            .send({ name: "Declared holiday", startDate: MID_LEAVE_HOLIDAY })
            .expect(201);

        const notifications = await pool.query(
            "SELECT message FROM notifications WHERE recipient_id = $1 AND type = 'LEAVE_DAYS_ADJUSTED'",
            [employee.id]
        );
        expect(notifications.rows).toHaveLength(1);
        // Unlike a pay-affecting date change, the figures are quoted here: the
        // point is that a number they were told has changed, and "your leave was
        // recounted" without saying from what to what isn't actionable.
        expect(notifications.rows[0].message).toMatch(/4 working day\(s\) instead of 5/);
        expect(notifications.rows[0].message).toMatch(/returned to your balance/);
    });
});
