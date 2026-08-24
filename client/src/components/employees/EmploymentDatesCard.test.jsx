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
        userService.updateEmploymentDates.mockResolvedValue({ ...employee, joining_date: "2026-02-01" });
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

    it("records an exit and reports what happened to the payslips", async () => {
        userService.recordEmployeeExit.mockResolvedValue({
            employee: { ...employee, last_working_day: "2026-07-10" },
            voided: ["2026-08"],
            regenerated: ["2026-07"],
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

        // "Exit recorded" on its own would hide the fact that a payslip was
        // just reissued with different figures.
        expect(await screen.findByText(/reissued, pro-rated: 2026-07/i)).toBeInTheDocument();
        expect(screen.getByText(/voided.*2026-08/i)).toBeInTheDocument();
        expect(onChanged).toHaveBeenCalled();
    });

    it("says only what happened — no payslip mention when none was touched", async () => {
        userService.recordEmployeeExit.mockResolvedValue({
            employee: { ...employee, last_working_day: "2026-07-10" },
            voided: [],
            regenerated: [],
        });
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /record exit/i }));
        await userEvent.type(screen.getByLabelText(/last working day/i), "2026-07-10");
        await userEvent.type(screen.getByLabelText(/reason/i), "Resigned");
        await userEvent.click(screen.getByRole("button", { name: /confirm exit/i }));

        expect(await screen.findByText(/exit recorded for 2026-07-10/i)).toBeInTheDocument();
        expect(screen.queryByText(/reissued/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/voided/i)).not.toBeInTheDocument();
    });

    it("surfaces the server's refusal when a payslip is in the way", async () => {
        // The 409 from a bare date edit. HR needs the server's own wording here,
        // because it is the thing that tells them to void the payslip first.
        userService.updateEmploymentDates.mockRejectedValue({
            response: {
                status: 409,
                data: { message: "Payroll for July 2026 has already been issued for this employee." },
            },
        });
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/Payroll for July 2026/);
    });

    it("closes the exit form on cancel without calling the service", async () => {
        renderWithProviders(<EmploymentDatesCard employee={employee} />);

        await userEvent.click(screen.getByRole("button", { name: /record exit/i }));
        await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

        expect(screen.queryByLabelText(/^reason$/i)).not.toBeInTheDocument();
        expect(userService.recordEmployeeExit).not.toHaveBeenCalled();
    });
});
