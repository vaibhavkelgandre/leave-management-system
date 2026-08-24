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
import { createRootHr, createUser, createSalaryStructure, createSalarySlip } from "./helpers/factories.js";
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
    it("sets the leaving date and reissues the exit month pro-rated, in one action", async () => {
        const hr = await createRootHr({ email: "exit-action-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-action", hr);
        // The wrong slip the exit is correcting: a full month, already issued.
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", netPay: 45825, actorId: hr.id });

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned, served notice" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.employee.last_working_day).toBe("2026-07-10");
        // HR is told what happened rather than having to go and look. The
        // exit month is *replaced*, not voided first: replaceSlipsForPeriod
        // already archives and supersedes, and voiding would only wipe the
        // reason it just recorded (it clears void_reason on reactivation).
        expect(response.body.data.voided).toEqual([]);
        expect(response.body.data.regenerated).toEqual(["2026-07"]);

        const slips = await slipsFor(employee.id);
        const active = slips.filter((slip) => slip.status === "ACTIVE");
        expect(active).toHaveLength(1);
        // 10 days of 31, so 21 days deducted at 1612.9032 → 11954.03.
        expect(Number(active[0].payable_days)).toBe(10);
        expect(Number(active[0].net_pay)).toBeCloseTo(11954.03, 2);
    });

    it("keeps the original figures as a revision, so both numbers survive", async () => {
        const hr = await createRootHr({ email: "exit-revision-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-revision", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", netPay: 45825, actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);

        // A payslip that changed underneath the employee with no record of what
        // it used to say would be worse than the drift it fixes.
        const revisions = await pool.query(
            `SELECT r.net_pay FROM salary_slip_revisions r
             JOIN salary_slips s ON s.id = r.salary_slip_id
             WHERE s.employee_id = $1`,
            [employee.id]
        );
        expect(revisions.rows.length).toBeGreaterThan(0);
        expect(revisions.rows.some((row) => Number(row.net_pay) === 45825)).toBe(true);
    });

    it("records HR's reason on a void that is the final state", async () => {
        const hr = await createRootHr({ email: "exit-reason-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-reason", hr);
        // August is entirely after the exit, so it is voided and never
        // reissued — which is exactly where the reason is durable and where it
        // answers a real question ("why is there no payslip for August?").
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-08", actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned, last day agreed with the manager" })
            .expect(200);

        const voided = (await slipsFor(employee.id)).find((slip) => slip.void_reason);
        expect(voided.void_reason).toMatch(/Resigned, last day agreed/);
        // Plus what the system did with it, so the slip explains itself.
        expect(voided.void_reason).toMatch(/2026-07-10/);
    });

    it("voids a payslip for a month entirely after the exit without reissuing one", async () => {
        const hr = await createRootHr({ email: "exit-after-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-after", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-08", actorId: hr.id });

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });

        expect(response.body.data.voided).toEqual(["2026-08"]);
        // Nothing to pay for time the employee wasn't employed — reissuing a
        // pro-rated slip there would be inventing a payment.
        expect(response.body.data.regenerated).toEqual([]);

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
        expect(response.body.data.regenerated).toEqual([]);

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

    it("succeeds where a bare date edit is refused, since it clears the payslip itself", async () => {
        const hr = await createRootHr({ email: "exit-vs-edit-hr@example.com" });
        const employee = await payrollReadyEmployee("exit-vs-edit", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });
        const hrAgent = await loginAs(hr);

        // Part A's blocking form: correct, but a dead end on its own.
        const edit = await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-07-10" });
        expect(edit.statusCode).toBe(409);

        // Two intents on one field: "edit this date" is blocked when a payslip
        // is in the way; "process this exit" clears the way itself.
        const exit = await hrAgent
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });
        expect(exit.statusCode).toBe(200);
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
});
