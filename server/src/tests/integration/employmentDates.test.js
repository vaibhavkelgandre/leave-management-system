// G22: exit proration, and the employment dates it depends on.
//
// The joining half of proration shipped in migration 035; the exit half was
// missing entirely, so someone leaving on the 10th of a 31-day month was paid
// the whole month. Both dates were also *self-editable* — and since
// joining_date already drove computeSlip's payable-day count, an employee could
// change their own salary from their own profile page. Both are now HR-set.
//
// Also covered: payroll ignored `status` completely, so a deactivated employee
// with a verified profile and a salary structure kept receiving full payslips
// every month.
import { describe, it, expect } from "vitest";
import {
    createRootHr,
    createUser,
    createSalaryStructure,
    createSalarySlip,
} from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { updateProfileStatus } from "../../repositories/userRepository.js";

async function verifiedEmployee(prefix, hr, overrides = {}) {
    const employee = await createUser({ managerId: hr.id, email: `${prefix}-emp@example.com`, ...overrides });
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

describe("Employment dates are HR-set, never self-set", () => {
    it("ignores joiningDate and lastWorkingDay smuggled into a self-profile update", async () => {
        const hr = await createRootHr({ email: "dates-self-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "dates-self-emp@example.com" });

        // The exact exploit this closes: joining_date drives the payable-day
        // count, so a self-set value is a self-set salary.
        const response = await (await loginAs(employee))
            .patch("/api/users/me/profile")
            .send({ designation: "Engineer", joiningDate: "2020-01-01", lastWorkingDay: "2030-01-01" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.designation).toBe("Engineer");
        expect(response.body.data.joining_date).toBeNull();
        expect(response.body.data.last_working_day).toBeNull();
    });

    it("lets HR set both dates for someone in their scope", async () => {
        const hr = await createRootHr({ email: "dates-hr-set@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "dates-hr-set-emp@example.com" });

        const response = await (await loginAs(hr))
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2026-07-20" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.employee.joining_date).toBe("2026-07-20");
    });

    it("refuses a non-HR caller", async () => {
        const hr = await createRootHr({ email: "dates-authz-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "dates-authz-mgr@example.com" });
        const employee = await createUser({ managerId: manager.id, email: "dates-authz-emp@example.com" });

        const response = await (await loginAs(manager))
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2026-07-01" });

        expect(response.statusCode).toBe(403);
    });

    it("refuses an HR admin from another branch with a 404, not a 403", async () => {
        const owningHr = await createRootHr({ email: "dates-owner-hr@example.com" });
        const strangerHr = await createRootHr({ email: "dates-stranger-hr@example.com" });
        const employee = await createUser({ managerId: owningHr.id, email: "dates-scoped-emp@example.com" });

        const response = await (await loginAs(strangerHr))
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2026-07-01" });

        // Same answer an unrelated employee gets: no more reason to know this
        // person exists.
        expect(response.statusCode).toBe(404);
    });

    it("rejects a last working day before the joining date", async () => {
        const hr = await createRootHr({ email: "dates-order-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "dates-order-emp@example.com" });
        const hrAgent = await loginAs(hr);

        await hrAgent.patch(`/api/employees/${employee.id}/employment-dates`).send({ joiningDate: "2026-07-01" });

        // Validated against the value already on record, not just the incoming
        // one, so setting either date alone is still checked against the other.
        const response = await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-06-30" });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/before the joining date/i);
    });

    it("voids a payslip the new dates no longer agree with, rather than refusing the edit", async () => {
        const hr = await createRootHr({ email: "dates-locked-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "dates-locked-emp@example.com" });
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });

        const response = await (await loginAs(hr))
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-07-10" });

        // This was a 409 telling HR to void the payslip themselves first.
        // Correct, but a dead end — and it never noticed a slip an *older* date
        // had already pro-rated, which is how a real employee ended up stuck on
        // 14 payable days for a month they worked in full.
        expect(response.statusCode).toBe(200);
        expect(response.body.data.voided).toEqual(["2026-07"]);
        expect(response.body.message).toMatch(/re-run payroll/i);
    });

    it("allows a date change for a period with no payslip yet, which is the normal case", async () => {
        const hr = await createRootHr({ email: "dates-open-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "dates-open-emp@example.com" });
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-05", actorId: hr.id });

        const response = await (await loginAs(hr))
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-07-10" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.employee.last_working_day).toBe("2026-07-10");
        // Nothing to void: no payslip covered a period these dates changed.
        expect(response.body.data.voided).toEqual([]);
    });
});

describe("Payroll respects employment dates and account status (G22)", () => {
    // July 2026 has 31 calendar days, so the per-day rate is 50000/31 =
    // 1612.9032. Fixed deductions total 4175.
    const PERIOD = "2026-07";
    const FULL_NET = 45825;

    async function preview(hrAgent, payPeriod = PERIOD) {
        const response = await hrAgent.post("/api/salary-slips/calculate").send({ payPeriod });
        expect(response.statusCode).toBe(200);
        return response.body.data.rows;
    }

    it("pro-rates the exit month down to the days actually worked", async () => {
        const hr = await createRootHr({ email: "exit-prorate-hr@example.com" });
        const employee = await verifiedEmployee("exit-prorate", hr);
        const hrAgent = await loginAs(hr);

        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2020-01-01", lastWorkingDay: "2026-07-10" })
            .expect(200);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        expect(row.status).toBe("ok");
        // 10 days employed of 31; the other 21 are deducted at the per-day rate.
        expect(Number(row.computed.payableDays)).toBe(10);
        expect(Number(row.computed.netPay)).toBeCloseTo(11954.03, 2);
        // Which is emphatically not the full month it used to pay.
        expect(Number(row.computed.netPay)).toBeLessThan(FULL_NET);
    });

    it("pays the full month when the last working day is the month end or later", async () => {
        const hr = await createRootHr({ email: "exit-fullmonth-hr@example.com" });
        const employee = await verifiedEmployee("exit-fullmonth", hr);
        const hrAgent = await loginAs(hr);

        // A notice period ending in a later month must not prorate this one —
        // the same comparison handles future-dated exits with no extra logic.
        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2020-01-01", lastWorkingDay: "2026-08-31" })
            .expect(200);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        expect(Number(row.computed.payableDays)).toBe(31);
        expect(Number(row.computed.netPay)).toBeCloseTo(FULL_NET, 2);
    });

    it("skips a period entirely after the employee left", async () => {
        const hr = await createRootHr({ email: "exit-after-hr@example.com" });
        const employee = await verifiedEmployee("exit-after", hr);
        const hrAgent = await loginAs(hr);

        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2020-01-01", lastWorkingDay: "2026-05-31" })
            .expect(200);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        // Without this, setting an exit date would prorate the exit month
        // correctly and then keep issuing full payslips every month after it.
        expect(row.status).toBe("skipped");
        expect(row.skipReason).toMatch(/already left/i);
        expect(row.computed).toBeNull();
    });

    it("skips an employee whose account is no longer active", async () => {
        const hr = await createRootHr({ email: "exit-inactive-hr@example.com" });
        const employee = await verifiedEmployee("exit-inactive", hr);
        const hrAgent = await loginAs(hr);

        // Deactivation is what HR already does when someone leaves, and payroll
        // ignored it completely — findSubtreeUsers walks the tree with no status
        // filter, so this employee kept receiving full payslips.
        await hrAgent.patch(`/api/users/${employee.id}/status`).send({ status: "INACTIVE" }).expect(200);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        expect(row.status).toBe("skipped");
        expect(row.skipReason).toMatch(/no longer active/i);
    });

    it("ignores leave dated after the employee left", async () => {
        const hr = await createRootHr({ email: "exit-leave-hr@example.com" });
        const employee = await verifiedEmployee("exit-leave", hr);
        const hrAgent = await loginAs(hr);

        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ joiningDate: "2020-01-01", lastWorkingDay: "2026-07-10" })
            .expect(200);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        // The LOP query is clamped to the employed window at both ends, so
        // leave after the exit can't deduct days from a period the employee
        // wasn't being paid for anyway.
        expect(Number(row.computed.lopDays)).toBe(0);
        expect(Number(row.computed.payableDays)).toBe(10);
    });

    it("leaves an ordinary full-month employee exactly as before", async () => {
        const hr = await createRootHr({ email: "exit-unchanged-hr@example.com" });
        const employee = await verifiedEmployee("exit-unchanged", hr);
        const hrAgent = await loginAs(hr);

        const row = (await preview(hrAgent)).find((entry) => entry.employeeId === employee.id);

        // No joining date, no exit date, active account: the formula must be
        // byte-identical to the pre-proration one.
        expect(row.status).toBe("ok");
        expect(Number(row.computed.payableDays)).toBe(31);
        expect(Number(row.computed.netPay)).toBeCloseTo(FULL_NET, 2);
    });
});
