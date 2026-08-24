// M1: the per-employee payroll lock.
//
// A payslip stores lop_days as a snapshot, and payroll only runs for a period
// that has fully ended — so there is always a gap between "the leave happened"
// and "payroll ran". Any leave decision landing after the run left the slip
// stating one thing and the leave record another, with nothing reconciling
// them. The likely direction was silent overpayment: a request approved late
// adds LOP days the slip never deducted, and nobody queries a payslip that
// came out too high.
//
// The lock closes that by refusing the decision instead, and pointing at the
// existing correction path: void the slip, which reopens the period, then
// decide and re-run. These tests pin both halves — that it blocks, and that
// voiding genuinely reopens it.
import { describe, it, expect } from "vitest";
import {
    createRootHr,
    createUser,
    createLeaveType,
    createLeaveRequest,
    createSalarySlip,
    voidSalarySlip,
} from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

// July 2026: the 13th and 14th are a Monday and Tuesday, so this is two
// working days rather than a range that quietly lands on a weekend.
const JULY_START = "2026-07-13";
const JULY_END = "2026-07-14";
const JULY_PERIOD = "2026-07";

async function team(emailPrefix) {
    const hr = await createRootHr({ email: `${emailPrefix}-hr@example.com` });
    const manager = await createUser({
        role: "MANAGER",
        managerId: hr.id,
        email: `${emailPrefix}-mgr@example.com`,
    });
    const employee = await createUser({ managerId: manager.id, email: `${emailPrefix}-emp@example.com` });
    const leaveType = await createLeaveType({ name: `${emailPrefix} Leave`, annualEntitlement: 20, countsAsLop: true });
    return { hr, manager, employee, leaveType };
}

describe("Payroll lock on leave decisions (M1)", () => {
    it("refuses to approve a request whose period already has an issued payslip", async () => {
        const { manager, employee, leaveType } = await team("lock-approve");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        const response = await (await loginAs(manager))
            .post(`/api/leave-requests/${request.id}/approve`)
            .send({});

        // 409, not 403: nobody lacks permission, the record is simply in a
        // state that forbids the change.
        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/July 2026/);
        // The message has to name the way out — a manager hitting this has no
        // idea payroll runs exist.
        expect(response.body.message).toMatch(/void/i);
    });

    it("allows the approval once the payslip is voided, which is the correction path", async () => {
        const { hr, manager, employee, leaveType } = await team("lock-void");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        const slip = await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        const blocked = await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({});
        expect(blocked.statusCode).toBe(409);

        await voidSalarySlip(slip.id, hr.id);

        const allowed = await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({});
        expect(allowed.statusCode).toBe(200);
        expect(allowed.body.data.status).toBe("APPROVED");
    });

    it("refuses an HR override for a period that already has a payslip", async () => {
        const { hr, manager, employee, leaveType } = await team("lock-override");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        // Decided on time, then payroll runs, then HR tries to reverse it —
        // the scenario that underpays an employee, and the only one they'd
        // actually notice.
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD, lopDays: 2 });

        const response = await (await loginAs(hr))
            .post(`/api/leave-requests/${request.id}/override`)
            .send({ toStatus: "REJECTED", comment: "Reversing after a dispute" });

        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/July 2026/);
    });

    it("still allows the employee to withdraw a locked request, since that can't change a payslip", async () => {
        const { employee, leaveType } = await team("lock-withdraw");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        // WITHDRAW only applies to a SUBMITTED request, and findLopWorkingDays
        // only counts APPROVED ones — so withdrawing cannot invalidate a slip.
        // Leaving it open is what lets an employee release the pending hold on
        // a request that can no longer be decided.
        const response = await (await loginAs(employee))
            .post(`/api/leave-requests/${request.id}/withdraw`)
            .send({});

        expect(response.statusCode).toBe(200);
        expect(response.body.data.status).toBe("WITHDRAWN");
    });

    it("locks a request spanning two months when either month has a payslip", async () => {
        const { manager, employee, leaveType } = await team("lock-spanning");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2026-07-28",
            endDate: "2026-08-03",
        });
        // Only July is slipped. A request is charged in full to every period it
        // overlaps, so checking August alone would let this through and corrupt
        // the July slip.
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        const response = await (await loginAs(manager))
            .post(`/api/leave-requests/${request.id}/approve`)
            .send({});

        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/July 2026/);
    });

    it("does not lock a request in a different period from the payslip", async () => {
        const { manager, employee, leaveType } = await team("lock-other-period");
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2026-09-14",
            endDate: "2026-09-15",
        });
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        const response = await (await loginAs(manager))
            .post(`/api/leave-requests/${request.id}/approve`)
            .send({});

        expect(response.statusCode).toBe(200);
    });

    it("locks per employee: a colleague's payslip doesn't block this employee's request", async () => {
        const { manager, employee, leaveType } = await team("lock-per-employee");
        const colleague = await createUser({ managerId: manager.id, email: "lock-colleague@example.com" });
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        // The whole point of deriving the lock from the employee's own slip:
        // voiding one person's payslip reopens exactly that person.
        await createSalarySlip({ employeeId: colleague.id, payPeriod: JULY_PERIOD });

        const response = await (await loginAs(manager))
            .post(`/api/leave-requests/${request.id}/approve`)
            .send({});

        expect(response.statusCode).toBe(200);
    });

    it("reports an authorization failure rather than the lock, for a manager outside the team", async () => {
        const { employee, leaveType } = await team("lock-authz");
        const outsider = await createRootHr({ email: "lock-outsider-hr@example.com" });
        const outsideManager = await createUser({
            role: "MANAGER",
            managerId: outsider.id,
            email: "lock-outsider-mgr@example.com",
        });
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: JULY_START,
            endDate: JULY_END,
        });
        await createSalarySlip({ employeeId: employee.id, payPeriod: JULY_PERIOD });

        const response = await (await loginAs(outsideManager))
            .post(`/api/leave-requests/${request.id}/approve`)
            .send({});

        // The lock runs after authorization on purpose: someone with no
        // business seeing this request should learn nothing about whether its
        // payroll has been issued.
        expect(response.statusCode).toBe(404);
    });
});
