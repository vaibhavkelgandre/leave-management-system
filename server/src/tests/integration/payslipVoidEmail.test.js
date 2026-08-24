// The email that tells an employee a payslip has been withdrawn.
//
// This exists because the alternatives were both worse. Voiding silently leaves
// someone holding a document that no longer applies with no way to know; and
// emailing the *corrected payslip* instead — which this system did briefly —
// means a departing employee discovers a pay cut by re-reading a payslip they
// had already read. Announcing the void, with the reason and a note that a
// corrected one will follow, is the same information without the ambush.
//
// mailService is mocked rather than the transport, matching payslipEmail.test.js
// and the convention everywhere else: exercise the real rules and the real
// database, without credentials or network.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRootHr, createUser, createSalaryStructure, createSalarySlip } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { updateProfileStatus } from "../../repositories/userRepository.js";
import { sendSalarySlipVoidedEmail } from "../../services/mailService.js";

vi.mock("../../services/mailService.js", () => ({
    sendSalarySlipVoidedEmail: vi.fn().mockResolvedValue(true),
    sendSalarySlipEmail: vi.fn().mockResolvedValue(true),
    sendEmployeeInviteEmail: vi.fn().mockResolvedValue(true),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
    vi.clearAllMocks();
    sendSalarySlipVoidedEmail.mockResolvedValue(true);
});

async function payrollReadyEmployee(prefix, hr) {
    const employee = await createUser({ managerId: hr.id, email: `${prefix}-emp@example.com`, firstName: "Asha" });
    await updateProfileStatus(employee.id, { status: "VERIFIED" });
    await createSalaryStructure({ employeeId: employee.id, actorId: hr.id });
    return employee;
}

// The send is fire-and-forget, so the assertion has to wait for a microtask
// rather than assuming it landed before the response did.
async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("Payslip void email", () => {
    it("emails the employee when an employment-date change voids their payslip", async () => {
        const hr = await createRootHr({ email: "voidmail-exit-hr@example.com" });
        const employee = await payrollReadyEmployee("voidmail-exit", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);
        await settle();

        expect(sendSalarySlipVoidedEmail).toHaveBeenCalledTimes(1);
        const sent = sendSalarySlipVoidedEmail.mock.calls[0][0];
        expect(sent.to).toBe("voidmail-exit-emp@example.com");
        expect(sent.firstName).toBe("Asha");
        // A human-readable period, not "2026-07" — this goes to an employee.
        expect(sent.payPeriodLabel).toBe("July 2026");
        // HR's words, plus what the system did with them.
        expect(sent.reason).toMatch(/Resigned/);
        expect(sent.reason).toMatch(/10 employed day\(s\), not 31/);
    });

    it("emails on an ordinary HR void too — a void is a void from the employee's side", async () => {
        const hr = await createRootHr({ email: "voidmail-manual-hr@example.com" });
        const employee = await payrollReadyEmployee("voidmail-manual", hr);
        const slip = await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });

        await (await loginAs(hr))
            .post(`/api/salary-slips/${slip.id}/void`)
            .send({ reason: "Wrong salary structure applied" })
            .expect(200);
        await settle();

        expect(sendSalarySlipVoidedEmail).toHaveBeenCalledTimes(1);
        expect(sendSalarySlipVoidedEmail.mock.calls[0][0].reason).toBe("Wrong salary structure applied");
    });

    it("sends nothing when the dates change but no payslip is affected", async () => {
        const hr = await createRootHr({ email: "voidmail-none-hr@example.com" });
        const employee = await payrollReadyEmployee("voidmail-none", hr);

        await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" })
            .expect(200);
        await settle();

        expect(sendSalarySlipVoidedEmail).not.toHaveBeenCalled();
    });

    it("a failed send never fails the void that has already been committed", async () => {
        const hr = await createRootHr({ email: "voidmail-fail-hr@example.com" });
        const employee = await payrollReadyEmployee("voidmail-fail", hr);
        await createSalarySlip({ employeeId: employee.id, payPeriod: "2026-07", actorId: hr.id });
        sendSalarySlipVoidedEmail.mockRejectedValue(new Error("SMTP down"));

        const response = await (await loginAs(hr))
            .post(`/api/employees/${employee.id}/exit`)
            .send({ lastWorkingDay: "2026-07-10", reason: "Resigned" });
        await settle();

        // The exit is recorded and the payslip voided regardless — the send is
        // fired after the response and never awaited, so a mail outage cannot
        // roll back an employment record.
        expect(response.statusCode).toBe(200);
        expect(response.body.data.voided).toEqual(["2026-07"]);
    });
});
