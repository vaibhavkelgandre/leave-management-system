// G23: re-running a pay period keeps the salary that period was run with.
//
// `salary_structures` holds one row per employee, overwritten on every change,
// with no effective dates — so `computeSlip` had no way to ask "what was this
// person earning in July". Re-running July after a raise recomputed it at the
// *new* salary, which mattered because void-and-re-run is how every correction
// in this app happens: a late leave approval, a leaving date, a stale
// pro-ration. The mechanism that exists to make a figure right introduced a
// different error.
//
// The fix needed no schema change: the slip already carries the whole basis
// (basic_pay, hra, both PF figures, esic, special_allowance, income_tax) and a
// voided slip keeps it. The rule is "a correction recomputes days, never
// salary".
import { describe, it, expect } from "vitest";
import pool from "../../config/db.js";
import { createRootHr, createUser, createSalaryStructure, createSalarySlip } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { updateProfileStatus } from "../../repositories/userRepository.js";

const PERIOD = "2026-07"; // 31 days, and already ended, so payroll may run it.

// ₹50,000 of earnings against ₹4,175 of fixed deductions → ₹45,825 for a full
// month. The raise below takes earnings to ₹60,000, i.e. ₹55,825.
const OLD_STRUCTURE = {
    basicSalary: 30000,
    hra: 12000,
    specialAllowance: 8000,
    pfEmployeeContribution: 1800,
    esic: 375,
    incomeTax: 2000,
};
const RAISED_STRUCTURE = { ...OLD_STRUCTURE, basicSalary: 36000, hra: 14400, specialAllowance: 9600 };

async function payrollReadyEmployee(prefix, hr, structure = OLD_STRUCTURE) {
    const employee = await createUser({ managerId: hr.id, email: `${prefix}-emp@example.com` });
    await updateProfileStatus(employee.id, { status: "VERIFIED" });
    await createSalaryStructure({ employeeId: employee.id, actorId: hr.id, ...structure });
    return employee;
}

async function preview(hrAgent, employeeId, payPeriod = PERIOD) {
    const response = await hrAgent.post("/api/salary-slips/calculate").send({ payPeriod });
    expect(response.statusCode).toBe(200);
    return response.body.data.rows.find((row) => row.employeeId === employeeId);
}

describe("Re-running a period keeps that period's salary (G23)", () => {
    it("uses the archived basis, not the raise entered afterwards", async () => {
        const hr = await createRootHr({ email: "basis-raise-hr@example.com" });
        const employee = await payrollReadyEmployee("basis-raise", hr);
        const hrAgent = await loginAs(hr);

        // July was run at the old salary, then voided — the ordinary shape of a
        // correction.
        const slip = await createSalarySlip({
            employeeId: employee.id,
            payPeriod: PERIOD,
            netPay: 45825,
            actorId: hr.id,
        });
        await hrAgent.post(`/api/salary-slips/${slip.id}/void`).send({ reason: "Correcting leave" }).expect(200);

        // The raise lands after the fact, as raises do.
        await createSalaryStructure({ employeeId: employee.id, actorId: hr.id, ...RAISED_STRUCTURE });

        const row = await preview(hrAgent, employee.id);

        expect(row.status).toBe("ok");
        // Without this fix the re-run paid ₹55,825 — ₹10,000 too much, for a
        // month the employee was on the old salary.
        expect(Number(row.computed.netPay)).toBeCloseTo(45825, 2);
        expect(Number(row.computed.basicPay)).toBe(30000);
        // Flagged, so "I gave her a raise and the number didn't move" reads as
        // intended rather than as a bug.
        expect(row.usedArchivedSalary).toBe(true);
    });

    it("recomputes the day-derived figures even while the salary stays fixed", async () => {
        const hr = await createRootHr({ email: "basis-days-hr@example.com" });
        const employee = await payrollReadyEmployee("basis-days", hr);
        const hrAgent = await loginAs(hr);

        const slip = await createSalarySlip({
            employeeId: employee.id,
            payPeriod: PERIOD,
            netPay: 45825,
            actorId: hr.id,
        });
        await hrAgent.post(`/api/salary-slips/${slip.id}/void`).send({ reason: "Recording an exit" }).expect(200);

        // A leaving date is the whole reason for the re-run — the days must move
        // even though the salary must not.
        await hrAgent
            .patch(`/api/employees/${employee.id}/employment-dates`)
            .send({ lastWorkingDay: "2026-07-10" })
            .expect(200);

        const row = await preview(hrAgent, employee.id);

        expect(Number(row.computed.payableDays)).toBe(10);
        // 10 of 31 days at the *old* per-day rate of 1612.9032.
        expect(Number(row.computed.netPay)).toBeCloseTo(11954.03, 2);
        // At the raised salary this would have been ₹15,179.84 — the error the
        // fix removes, still present in a pro-rated month.
        expect(Number(row.computed.netPay)).not.toBeCloseTo(15179.84, 2);
    });

    it("uses the current structure for a period that has never been run", async () => {
        const hr = await createRootHr({ email: "basis-first-hr@example.com" });
        const employee = await payrollReadyEmployee("basis-first", hr, RAISED_STRUCTURE);
        const hrAgent = await loginAs(hr);

        const row = await preview(hrAgent, employee.id);

        // No prior slip means no archived basis, so the current structure is
        // the only answer — and the right one.
        expect(Number(row.computed.netPay)).toBeCloseTo(55825, 2);
        expect(row.usedArchivedSalary).toBeUndefined();
    });

    it("keeps the basis from a slip that was replaced, not only one that was voided", async () => {
        const hr = await createRootHr({ email: "basis-replaced-hr@example.com" });
        const employee = await payrollReadyEmployee("basis-replaced", hr);
        const hrAgent = await loginAs(hr);

        // An ACTIVE slip still counts as the record of that period's salary. The
        // preview reports `already_generated` rather than figures, but the basis
        // is what matters once it is voided and re-run.
        await createSalarySlip({ employeeId: employee.id, payPeriod: PERIOD, netPay: 45825, actorId: hr.id });
        await createSalaryStructure({ employeeId: employee.id, actorId: hr.id, ...RAISED_STRUCTURE });

        const stillGenerated = await preview(hrAgent, employee.id);
        expect(stillGenerated.status).toBe("already_generated");

        const slips = await pool.query("SELECT id FROM salary_slips WHERE employee_id = $1", [employee.id]);
        await hrAgent
            .post(`/api/salary-slips/${slips.rows[0].id}/void`)
            .send({ reason: "Correcting" })
            .expect(200);

        const row = await preview(hrAgent, employee.id);
        expect(Number(row.computed.netPay)).toBeCloseTo(45825, 2);
        expect(row.usedArchivedSalary).toBe(true);
    });

    it("still skips an employee whose salary structure has been removed", async () => {
        const hr = await createRootHr({ email: "basis-nostructure-hr@example.com" });
        const employee = await payrollReadyEmployee("basis-nostructure", hr);
        const hrAgent = await loginAs(hr);
        const slip = await createSalarySlip({ employeeId: employee.id, payPeriod: PERIOD, actorId: hr.id });
        await hrAgent.post(`/api/salary-slips/${slip.id}/void`).send({ reason: "Correcting" }).expect(200);

        await pool.query("DELETE FROM salary_structures WHERE employee_id = $1", [employee.id]);

        const row = await preview(hrAgent, employee.id);

        // The archived basis supersedes the structure's *values*, never its
        // existence: a structure is what marks someone as on payroll, so
        // removing it must stop payment rather than let an archive keep it
        // going.
        expect(row.status).toBe("skipped");
        expect(row.skipReason).toMatch(/no salary structure/i);
    });
});
