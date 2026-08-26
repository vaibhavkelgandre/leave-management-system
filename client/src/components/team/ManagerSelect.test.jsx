import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../tests/renderWithProviders.jsx";
import { ManagerSelect } from "./ManagerSelect.jsx";

const HR = { id: "hr1", role: "HR_ADMIN", first_name: "Asha", last_name: "Rao" };

function render(props = {}) {
    return renderWithProviders(
        <ManagerSelect
            id="managerId"
            label="Manager"
            value=""
            onChange={vi.fn()}
            options={[]}
            allowNone={false}
            required
            {...props}
        />
    );
}

describe("ManagerSelect", () => {
    it("lists eligible managers grouped by role", () => {
        render({ options: [HR], targetRole: "EMPLOYEE" });

        expect(screen.getByRole("option", { name: "Asha Rao" })).toBeInTheDocument();
        expect(screen.getByLabelText("Manager")).toBeEnabled();
    });

    it("labels the viewer's own option as You", () => {
        render({ options: [HR], targetRole: "HR_ADMIN", currentUserId: "hr1" });

        expect(screen.getByRole("option", { name: "You" })).toBeInTheDocument();
    });

    // The first-invite dead end: a freshly set-up organisation has only a
    // SUPER_ADMIN, who may manage an HR_ADMIN and nobody else. So choosing
    // "Employee" or "Manager" as the very first invite leaves this list empty,
    // and an unexplained empty dropdown reads as a broken form.
    describe("with no eligible manager yet", () => {
        it("says to invite an HR admin first, for an employee", () => {
            render({ options: [], targetRole: "EMPLOYEE" });

            expect(screen.getByText(/invite an hr admin first/i)).toBeInTheDocument();
        });

        it("says the same for a manager, naming the rule that applies to them", () => {
            render({ options: [], targetRole: "MANAGER" });

            expect(screen.getByText(/no hr admin to report to yet/i)).toBeInTheDocument();
            expect(screen.getByText(/managers can only report to one/i)).toBeInTheDocument();
        });

        it("disables the picker rather than offering an empty one", () => {
            render({ options: [], targetRole: "EMPLOYEE" });

            expect(screen.getByLabelText("Manager")).toBeDisabled();
            expect(screen.getByRole("option", { name: /nobody available yet/i })).toBeInTheDocument();
        });

        it("stays enabled when no manager is a legitimate answer", () => {
            // allowNone means "No manager" is a real choice, so an empty
            // candidate list is not an error state and must not be disabled.
            render({ options: [], allowNone: true, targetRole: "HR_ADMIN" });

            expect(screen.getByLabelText("Manager")).toBeEnabled();
            expect(screen.getByRole("option", { name: /no manager/i })).toBeInTheDocument();
        });
    });
});
