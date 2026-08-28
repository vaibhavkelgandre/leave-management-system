import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAuthValue } from "../../tests/renderWithProviders.jsx";
import { DelegationForm } from "./DelegationForm.jsx";
import * as userService from "../../services/userService.js";
import * as delegationService from "../../services/delegationService.js";

vi.mock("../../services/userService.js");
vi.mock("../../services/delegationService.js");

const managerAuthValue = makeAuthValue({ user: { id: "mgr-1", first_name: "Priya", role: "MANAGER" } });

function renderForm(props = {}) {
    return renderWithProviders(<DelegationForm onSaved={vi.fn()} {...props} />, { authValue: managerAuthValue });
}

describe("DelegationForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        userService.getUserOptions.mockResolvedValue([
            { id: "mgr-1", first_name: "Priya", last_name: "Self" },
            { id: "mgr-2", first_name: "Rohit", last_name: "Peer" },
        ]);
    });

    it("excludes the current user from the delegate options", async () => {
        renderForm();

        expect(await screen.findByRole("option", { name: /rohit peer/i })).toBeInTheDocument();
        expect(screen.queryByRole("option", { name: /priya self/i })).not.toBeInTheDocument();
    });

    it("blocks submission when the end date is before the start date", async () => {
        renderForm();

        await screen.findByRole("option", { name: /rohit peer/i });
        await userEvent.selectOptions(screen.getByLabelText(/delegate/i), "mgr-2");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-06-10");

        // Bypasses the End date input's min={startDate} constraint validation,
        // same technique as the equivalent HolidayForm/RequestLeaveForm tests.
        const form = screen.getByRole("button", { name: /nominate delegate/i }).closest("form");
        fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: "2027-06-01" } });
        fireEvent.submit(form);

        expect(await screen.findByRole("alert")).toHaveTextContent("End date can't be before the start date");
        expect(delegationService.createDelegation).not.toHaveBeenCalled();
    });

    // Mirrors the server's rule: a delegate's authority is resolved live, so a
    // window that has already ended could never make anyone a delegate.
    it("blocks submission when the window has already ended", async () => {
        renderForm();

        await screen.findByRole("option", { name: /rohit peer/i });
        await userEvent.selectOptions(screen.getByLabelText(/delegate/i), "mgr-2");

        // Both fireEvent.change, to bypass the End date input's own min= bound
        // — the point of the test is the JS guard behind it.
        const form = screen.getByRole("button", { name: /nominate delegate/i }).closest("form");
        fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: "2020-01-06" } });
        fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: "2020-01-10" } });
        fireEvent.submit(form);

        expect(await screen.findByRole("alert")).toHaveTextContent(/already ended/i);
        expect(delegationService.createDelegation).not.toHaveBeenCalled();
    });

    it("submits the delegation and reports the result", async () => {
        const created = { id: "deleg-1" };
        delegationService.createDelegation.mockResolvedValue(created);
        const onSaved = vi.fn();
        renderForm({ onSaved });

        await screen.findByRole("option", { name: /rohit peer/i });
        await userEvent.selectOptions(screen.getByLabelText(/delegate/i), "mgr-2");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-06-01");
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-06-14");
        await userEvent.click(screen.getByRole("button", { name: /nominate delegate/i }));

        expect(delegationService.createDelegation).toHaveBeenCalledWith({
            delegateId: "mgr-2",
            startDate: "2027-06-01",
            endDate: "2027-06-14",
        });
        expect(onSaved).toHaveBeenCalledWith(created);
    });

    it("prefills from an existing delegation and updates it instead of creating one", async () => {
        const updated = { id: "deleg-1", delegate_id: "mgr-2" };
        delegationService.updateDelegation.mockResolvedValue(updated);
        const onSaved = vi.fn();
        renderForm({
            delegation: {
                id: "deleg-1",
                delegate_id: "mgr-2",
                start_date: "2027-06-01",
                end_date: "2027-06-14",
            },
            onSaved,
        });

        await screen.findByRole("option", { name: /rohit peer/i });
        expect(screen.getByLabelText(/delegate/i)).toHaveValue("mgr-2");
        expect(screen.getByLabelText(/start date/i)).toHaveValue("2027-06-01");
        expect(screen.getByLabelText(/end date/i)).toHaveValue("2027-06-14");

        await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

        expect(delegationService.updateDelegation).toHaveBeenCalledWith("deleg-1", {
            delegateId: "mgr-2",
            startDate: "2027-06-01",
            endDate: "2027-06-14",
        });
        expect(delegationService.createDelegation).not.toHaveBeenCalled();
        expect(onSaved).toHaveBeenCalledWith(updated);
    });

    it("surfaces the server's error message", async () => {
        delegationService.createDelegation.mockRejectedValue({
            response: { data: { message: "You already have a delegation covering one or more of these dates" } },
        });
        renderForm();

        await screen.findByRole("option", { name: /rohit peer/i });
        await userEvent.selectOptions(screen.getByLabelText(/delegate/i), "mgr-2");
        await userEvent.type(screen.getByLabelText(/start date/i), "2027-06-01");
        await userEvent.type(screen.getByLabelText(/end date/i), "2027-06-14");
        await userEvent.click(screen.getByRole("button", { name: /nominate delegate/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent(/already have a delegation/i);
    });
});
