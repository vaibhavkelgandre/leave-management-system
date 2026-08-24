// The HR-only control over the two dates payroll computes from.
//
// The point of these tests is the *separation*: saving a joining date and
// recording an exit are different intents with different consequences, and the
// exit one has to tell HR what it did to the payslips — there is no other place
// they would find out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../tests/renderWithProviders.jsx";
import { EmploymentDatesCard } from "./EmploymentDatesCard.jsx";
import * as userService from "../../services/userService.js";

vi.mock("../../services/userService.js");

const employee = {
    id: "emp-1",
    first_name: "Asha",
    last_name: "Verma",
    joining_date: "2026-01-15",
    last_working_day: null,
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("EmploymentDatesCard", () => {
    it("prefills the joining date and saves an edit", async () => {
        userService.updateEmploymentDates.mockResolvedValue({
            employee: { ...employee, joining_date: "2026-02-01" },
            voided: [],
        });
        const onChanged = vi.fn();
        renderWithProviders(<EmploymentDatesCard employee={employee} onChanged={onChanged} />);

        const field = screen.getByLabelText(/joining date/i);
        expect(field).toHaveValue("2026-01-15");

        await userEvent.clear(field);
        await userEvent.type(field, "2026-02-01");
        await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

        expect(userService.updateEmploymentDates).toHaveBeenCalledWith("emp-1", { joiningDate: "2026-02-01" });
        expect(await screen.findByText(/joining date saved/i)).toBeInTheDocument();
        expect(onChanged).toHaveBeenCalled();
    });

    it("says the employee is still employed when no leaving date is recorded", () => {
        renderWithProviders(<EmploymentDatesCard employee={employee} />);
        expect(screen.getByText(/still employed/i)).toBeInTheDocument();
    });

    it("shows the recorded leaving date when there is one", () => {
        renderWithProviders(<EmploymentDatesCard employee={{ ...employee, last_working_day: "2026-07-10" }} />);
        expect(screen.getByText("2026-07-10")).toBeInTheDocument();
    });

    it("records an exit and names the payslips it voided", async () => {
        userService.recordEmployeeExit.mockResolvedValue({
            employee: { ...employee, last_working_day: "2026-07-10" },
            voided: ["2026-07", "2026-08"],
        });
        const onChanged = vi.fn();
        renderWithProviders(<EmploymentDatesCard employee={employee} onChanged={onChanged} />);

        await userEvent.click(screen.getByRole("button", { name: /record exit/i }));
        await userEvent.type(screen.getByLabelText(/last working day/i), "2026-07-10");
        await userEvent.type(screen.getByLabelText(/reason/i), "Resigned");
        await userEvent.click(screen.getByRole("button", { name: /confirm exit/i }));

        expect(userService.recordEmployeeExit).toHaveBeenCalledWith("emp-1", {
            lastWorkingDay: "2026-07-10",
            reason: "Resigned",
        });

        // "Exit recorded" on its own would hide the fact that two payslips
        // were just withdrawn, and that corrected ones need a payroll re-run.
        expect(await screen.findByText(/2 payslip\(s\) voided \(2026-07, 2026-08\)/i)).toBeInTheDocument();
        expect(screen.getByText(/re-run payroll/i)).toBeInTheDocument();
        expect(onChanged).toHaveBeenCalled();
    });

    it("says only what happened — no payslip mention when none was touched", async () => {
        userService.recordEmployeeExit.mockResolvedValue({
            employee: { ...employee, last_working_day: "2026-07-10" },
            voided: [],
        });
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /record exit/i }));
        await userEvent.type(screen.getByLabelText(/last working day/i), "2026-07-10");
        await userEvent.type(screen.getByLabelText(/reason/i), "Resigned");
        await userEvent.click(screen.getByRole("button", { name: /confirm exit/i }));

        expect(await screen.findByText(/exit recorded for 2026-07-10/i)).toBeInTheDocument();
        expect(screen.queryByText(/voided/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/re-run payroll/i)).not.toBeInTheDocument();
    });

    it("says which payslips a date correction withdrew", async () => {
        // A bare date edit used to be refused with a 409 when a payslip covered
        // an affected period. It now voids what no longer agrees — so the
        // message has to name the periods, since HR has no other way to learn
        // that a payslip was just withdrawn.
        userService.updateEmploymentDates.mockResolvedValue({
            employee: { ...employee, joining_date: "2026-02-01" },
            voided: ["2026-02"],
        });
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

        expect(await screen.findByText(/1 payslip\(s\) voided \(2026-02\)/i)).toBeInTheDocument();
    });

    it("surfaces a server error without pretending it succeeded", async () => {
        userService.updateEmploymentDates.mockRejectedValue({
            response: { status: 400, data: { message: "Last working day cannot be before the joining date" } },
        });
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be before the joining date/i);
    });

    it("closes the exit form on cancel without calling the service", async () => {
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /record exit/i }));
        await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

        expect(screen.queryByLabelText(/^reason$/i)).not.toBeInTheDocument();
        expect(userService.recordEmployeeExit).not.toHaveBeenCalled();
    });
});
