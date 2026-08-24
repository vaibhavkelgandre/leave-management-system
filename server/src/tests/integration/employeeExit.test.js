// Part B of G22: the exit action.
//
// Part A made a bare date edit refuse (409) when a payslip already covered an
// affected period, which is safe but hands HR a chore: void the slip, set the
// date, re-run. This action does all three, so the thing HR actually wants to
// do is one operation.
//
// Void-and-reissue rather than refuse is deliberate here, and it is the
// opposite call from leave decisions (assertPeriodsOpen blocks and never
// auto-corrects). The difference is who is deciding: there, approving a leave
// request would have quietly rewritten a payslip the employee already held;
// here a human is explicitly processing an exit, with a reason recorded against
// the void, using the same void-and-rerun path — one button instead of five
// manual steps.
import { describe, it, expect } from "vitest";
import pool from "../../config/db.js";
import {
    createRootHr,
    createUser,
    createSalaryStructure,
    createSalarySlip,
    createLeaveType,
    createLeaveRequest,
} from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { updateProfileStatus } from "../../repositories/userRepository.js";

async function payrollReadyEmployee(prefix, hr) {
    const employee = await createUser({ managerId: hr.id, email: `${prefix}-emp@example.com` });
    await updateProfileStatus(employee.id, { status: "VERIFIED" });
    await createSalaryStructure({
        employeeId: employee.id,
        basicSalary: 30000,
        hra: 12000,
        specialAllowance: 8000,
        pfEmployeeContribution: 1800,
        esic: 375,
        incomeTax: 2000,
        actorId: hr.id,
    });
    return employee;
}

async function slipsFor(employeeId) {
    const result = await pool.query(
        `SELECT pay_period, status, net_pay, payable_days, void_reason
         FROM salary_slips WHERE employee_id = $1 ORDER BY pay_period, status`,
        [employeeId]
    );
    return result.rows;
}

describe("Recording an employee exit (G22 part B)", () => {
    it("sets the leaving date and voids the payslip the date no longer agrees with", async () => {
        const hr = await createRootHr({ email: "exit-action-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-action", hr);
        // The wrong slip the exit is correcting: a full month, already issued.
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", netPay: 45825, actorId: hr.id });

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned, served notice" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.employee.last_working_day).toBe("2026-07-10");
        // Voided, not silently recomputed. Replacing the figures in place meant
        // a departing employee discovered a pay cut by re-reading a payslip
        // they had already read; voiding says so, and HR re-runs payroll to
        // issue the corrected one when they choose.
        expect(response.body.data.voided).toEqual(["2026-07"]);

        const slips = await slipsFor(employee.id);
        expect(slips.filter((slip) => slip.status === "ACTIVE")).toHaveLength(0);
        // The reason has to explain itself to whoever reads it later.
        const voided = slips.find((slip) => slip.pay_period === "2026-07");
        expect(voided.void_reason).toMatch(/10 employed day\(s\), not 31/);
        expect(voided.void_reason).toMatch(/re-run/i);
    });

    // The bug that made this whole approach necessary: an exit date moving
    // *later* left a slip an earlier date had already pro-rated, and nothing
    // ever revisited it. A real employee sat on 14 payable days for a month
    // they had worked in full.
    it("voids a slip left stale by an earlier, different leaving date", async () => {
        const hr = await createRootHr({ email: "exit-stale-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-stale", hr);
        const hrAgent = await loginAs(hr);

        // Order matters: the leaving date is recorded first, *then* payroll runs
        // and produces a slip pro-rated to 14 days. That is the real sequence,
        // and it's what leaves a consistent-at-the-time slip behind.
        await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-06-14", reason: "Resigned" })
            .expect(200);
        await createSalarySlip({
            employeeId: employee.id,
            payPeriod: "2026-06",
            payableDays: 14,
            actorId: hr.id,
        });

        // The date then moves later: they actually worked all of June.
        const response = await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-31", reason: "Notice extended" });

        expect(response.statusCode).toBe(200);
        // Comparing employed *days* rather than "which month contains the date"
        // is what catches this — June is neither the exit month nor after it.
        const june = (await slipsFor(employee.id)).find((slip) => slip.pay_period === "2026-06");
        expect(june.status).toBe("VOIDED");
        expect(june.void_reason).toMatch(/30 employed day\(s\)/);
    });

    it("records HR's reason on the void, alongside what the system did with it", async () => {
        const hr = await createRootHr({ email: "exit-reason-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-reason", hr);
        // August is entirely after the exit, so nothing was employed in it.
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-08", actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned, last day agreed with the manager" })
            .expect(200);

        const voided = (await slipsFor(employee.id)).find((slip) => slip.void_reason);
        expect(voided.void_reason).toMatch(/Resigned, last day agreed/);
        // Plus what the system did with it, so the slip explains itself.
        expect(voided.void_reason).toMatch(/not employed during this period/i);
    });

    it("voids a payslip for a month entirely after the exit without reissuing one", async () => {
        const hr = await createRootHr({ email: "exit-after-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-after", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-08", actorId: hr.id });

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });

        expect(response.body.data.voided).toEqual(["2026-08"]);

        const active = (await slipsFor(employee.id)).filter((slip) => slip.status === "ACTIVE");
        expect(active).toHaveLength(0);
    });

    it("leaves payslips for months the employee worked in full alone", async () => {
        const hr = await createRootHr({ email: "exit-before-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-before", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-05", netPay: 45825, actorId: hr.id });

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });

        expect(response.body.data.voided).toEqual([]);

        const slips = await slipsFor(employee.id);
        expect(slips).toHaveLength(1);
        expect(slips[0].status).toBe("ACTIVE");
        expect(Number(slips[0].net_pay)).toBe(45825);
    });

    it("handles an exit with no payslips at all — the ordinary case", async () => {
        const hr = await createRootHr({ email: "exit-noslips-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-noslips", hr);

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.voided).toEqual([]);
        expect(response.body.data.employee.last_working_day).toBe("2026-07-10");
    });

    it("voids the same slips whether HR edits the date or records an exit", async () => {
        const hr = await createRootHr({ email: "exit-vs-edit-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-vs-edit", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });
        const hrAgent = await loginAs(hr);

        // This used to be a 409 telling HR to go and void the payslip
        // themselves. That was safe but a dead end, and it also never noticed a
        // slip an older date had already pro-rated. Both paths now void what no
        // longer agrees with the dates.
        const edit = await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-07-10" });

        expect(edit.statusCode).toBe(200);
        expect(edit.body.data.voided).toEqual(["2026-07"]);
        expect(edit.body.message).toMatch(/re-run payroll/i);
    });

    it("requires a reason, since it lands on the void record", async () => {
        const hr = await createRootHr({ email: "exit-noreason-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-noreason", hr);

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10" });

        expect(response.statusCode).toBe(422);
    });

    it("rejects a leaving date before the joining date", async () => {
        const hr = await createRootHr({ email: "exit-order-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-order", hr);
        const hrAgent = await loginAs(hr);
        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2026-07-01" })
            .expect(200);

        const response = await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-06-15", reason: "Resigned" });

        expect(response.statusCode).toBe(400);
    });

    it("refuses a manager, and an HR admin from another branch", async () => {
        const hr = await createRootHr({ email: "exit-authz-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "exit-authz-mgr@example.com" });
        const employee = await payrollReadyEmployee("exit-authz", hr);
        const strangerHr = await createRootHr({ email: "exit-stranger-hr@example.com" });

        const asManager = await (await loginAs(manager))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });
        expect(asManager.statusCode).toBe(403);

        const asStranger = await (await loginAs(strangerHr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });
        expect(asStranger.statusCode).toBe(404);

        // Neither attempt may have recorded anything.
        const result = await pool.query("SELECT last_working_day FROM users WHERE id = $1", [employee.id]);
        expect(result.rows[0].last_working_day).toBeNull();
    });

    it("excludes the employee from payroll for every month after the exit", async () => {
        const hr = await createRootHr({ email: "exit-future-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-future", hr);
        const hrAgent = await loginAs(hr);

        await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-06-30", reason: "Resigned" })
            .expect(200);

        const preview = await hrAgent.post("/api/salary-slips/calculate").send({ payPeriod: "2026-07" });
        const row = preview.body.data.rows.find((entry) => entry.employeeId === employee.id);

        expect(row.status).toBe("skipped");
        expect(row.skipReason).toMatch(/already left/i);
    });

    it("blocks new leave that starts after the last working day", async () => {
        const hr = await createRootHr({ email: "exit-leaveguard-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-leaveguard", hr);
        const hrAgent = await loginAs(hr);
        await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);

        const leaveType = await createLeaveType({ name: "Exit Guard Leave", annualEntitlement: 20 });
        const response = await (await loginAs(employee)).post("/api/leave-requests").send({
            leaveTypeId: leaveType.id,
            startDate: "2026-07-20",
            endDate: "2026-07-21",
            reason: "After my last day",
        });

        // Payroll would clamp its own window and simply ignore these days, but
        // the request would still sit in the employee's history holding pending
        // or taken days for a period they were not employed for.
        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/last working day/i);
    });

    it("blocks approving leave when an exit is recorded after the request was raised", async () => {
        const hr = await createRootHr({ email: "exit-approveguard-hr@example.com" });
        const manager = await createUser({
            role: "MANAGER",
            managerId: hr.id,
            email: "exit-approveguard-mgr@example.com",
        });
        const employee = await createUser({ managerId: manager.id, email: "exit-approveguard-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Exit Approve Guard Leave", annualEntitlement: 20 });

        // The common order of events: book leave, then resign.
        const leaveRequest = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2026-09-14",
            endDate: "2026-09-15",
        });
        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-08-31", reason: "Resigned" })
            .expect(200);

        const response = await (await loginAs(manager))
            .post(`/api/leave-requests/${leaveRequest.id}/approve`)
            .send({});

        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/last working day/i);
    });

    it("tells the employee the payslip was voided, in-app and by email", async () => {
        const hr = await createRootHr({ email: "exit-tellthem-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-tellthem", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", netPay: 45825, actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);

        // An earlier version emailed the *corrected payslip* instead, which is
        // how someone discovers a pay cut by re-reading a document. Announcing
        // the void — and that a corrected one will follow — is the same
        // information without the ambush. (The send itself is asserted in
        // payslipVoidEmail.test.js, where mailService is mocked.)
        const notifications = await pool.query(
            "SELECT type FROM notifications WHERE recipient_id = $1",
            [employee.id]
        );
        const types = notifications.rows.map((row) => row.type);
        expect(types).toContain("SALARY_SLIP_VOIDED");
        expect(types).toContain("EMPLOYMENT_DATES_UPDATED");
        // Nothing announces a fresh payslip, because none was issued.
        expect(types).not.toContain("SALARY_SLIP_GENERATED");
    });

    it("notifies the employee that HR recorded their exit, without quoting the date", async () => {
        const hr = await createRootHr({ email: "exit-notify-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-notify", hr);

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);

        const notifications = await pool.query(
            "SELECT message FROM notifications WHERE recipient_id = $1 AND type = 'EMPLOYMENT_DATES_UPDATED'",
            [employee.id]
        );
        expect(notifications.rows).toHaveLength(1);
        // A notification list is glanced at casually, often with someone else
        // looking at the screen — so no dates and no figures in the message.
        expect(notifications.rows[0].message).not.toMatch(/2026-07-10/);
        expect(notifications.rows[0].message).toMatch(/last working day/i);
    });
});
