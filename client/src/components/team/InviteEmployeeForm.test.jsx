import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAuthValue } from "../../tests/renderWithProviders.jsx";
import { InviteEmployeeForm } from "./InviteEmployeeForm.jsx";
import * as userService from "../../services/userService.js";
import { makeUser } from "../../tests/fixtures/users.js";
import { ROLES } from "../../constants/roles.js";

vi.mock("../../services/userService.js");

const hrAuthValue = makeAuthValue({ user: { id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN } });

function renderForm(props = {}) {
    return renderWithProviders(<InviteEmployeeForm {...props} />, { authValue: hrAuthValue });
}

describe("InviteEmployeeForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks who each role reports to — including an HR admin, who now reports to whoever created them", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN }),
            makeUser({ role: ROLES.MANAGER }),
        ]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        // Employee -> reports to a manager.
        expect(screen.getByLabelText("Manager")).toBeInTheDocument();

        // Manager -> reports to an HR admin instead.
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.MANAGER);
        expect(screen.getByLabelText("Reporting HR admin")).toBeInTheDocument();
        expect(screen.queryByLabelText("Manager")).not.toBeInTheDocument();

        // HR admin -> reports to another HR admin (their creator by default).
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        expect(screen.getByLabelText("Reports to")).toBeInTheDocument();
        expect(screen.queryByLabelText("Reporting HR admin")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Manager")).not.toBeInTheDocument();
    });

    it("offers the super admin alongside other HR admins as who a new HR admin can report to", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN }),
            makeUser({ id: "super-1", first_name: "Sam", role: ROLES.SUPER_ADMIN }),
            makeUser({ id: "mgr-1", first_name: "Manoj", role: ROLES.MANAGER }),
        ]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);

        const select = screen.getByLabelText("Reports to");
        expect(within(select).getByRole("option", { name: /Sam/ })).toBeInTheDocument();
        // A manager is never a valid choice here, super admin or not.
        expect(within(select).queryByRole("option", { name: /Manoj/ })).not.toBeInTheDocument();

        // Confirms ManagerSelect actually renders the option under its own
        // optgroup, not just that the filter upstream accepted it — the two
        // have silently drifted apart before.
        await userEvent.selectOptions(select, "super-1");
        expect(select).toHaveValue("super-1");
    });

    it("defaults the HR admin reporting-line picker to the inviter themself, labeled \"You\"", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN }),
            makeUser({ id: "hr-2", first_name: "Amit", role: ROLES.HR_ADMIN }),
            makeUser({ id: "mgr-1", first_name: "Manoj", role: ROLES.MANAGER }),
        ]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);

        const select = screen.getByLabelText("Reports to");
        expect(select).toHaveValue("hr-viewer");
        expect(within(select).getByText("You")).toBeInTheDocument();
        // Only other HR admins are offered, never a manager.
        expect(within(select).getByText("Amit User")).toBeInTheDocument();
        expect(within(select).queryByText(/manoj/i)).not.toBeInTheDocument();
    });

    it("submits an HR admin invite with the picked HR admin as managerId", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-viewer", first_name: "Priya", role: ROLES.HR_ADMIN }),
            makeUser({ id: "hr-2", first_name: "Amit", role: ROLES.HR_ADMIN }),
        ]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-hr" }),
            inviteLink: "http://localhost:5173/invite/hr-link",
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "Second");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hr");
        await userEvent.type(screen.getByLabelText(/email/i), "secondhr@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        await userEvent.selectOptions(screen.getByLabelText("Reports to"), "hr-2");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(userService.inviteEmployee).toHaveBeenCalledWith(
            expect.objectContaining({ role: ROLES.HR_ADMIN, managerId: "hr-2" })
        );
    });

    it("offers only HR admins as the reporting line for a new manager", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-1", first_name: "Hema", role: ROLES.HR_ADMIN }),
            makeUser({ id: "mgr-1", first_name: "Manoj", role: ROLES.MANAGER }),
            makeUser({ id: "emp-1", first_name: "Asha", role: ROLES.EMPLOYEE }),
        ]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        // As an employee, both the manager and the HR admin are valid choices.
        const asEmployee = screen.getByLabelText("Manager");
        expect(within(asEmployee).getByRole("option", { name: /Manoj/ })).toBeInTheDocument();
        expect(within(asEmployee).getByRole("option", { name: /Hema/ })).toBeInTheDocument();

        // As a manager, only the HR admin remains.
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.MANAGER);
        const asManager = screen.getByLabelText("Reporting HR admin");
        expect(within(asManager).getByRole("option", { name: /Hema/ })).toBeInTheDocument();
        expect(within(asManager).queryByRole("option", { name: /Manoj/ })).not.toBeInTheDocument();
    });

    it("clears an already-picked person when the role changes", async () => {
        userService.getUserOptions.mockResolvedValue([
            makeUser({ id: "hr-1", first_name: "Hema", role: ROLES.HR_ADMIN }),
            makeUser({ id: "mgr-1", first_name: "Manoj", role: ROLES.MANAGER }),
        ]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.selectOptions(screen.getByLabelText("Manager"), "mgr-1");
        expect(screen.getByLabelText("Manager")).toHaveValue("mgr-1");

        // Manoj isn't a valid choice for a manager, so the selection must reset.
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.MANAGER);
        expect(screen.getByLabelText("Reporting HR admin")).toHaveValue("");
    });

    it("submits a manager with the HR admin they report to", async () => {
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "hr-1", first_name: "Hema", role: ROLES.HR_ADMIN })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-2" }),
            inviteLink: "http://localhost:5173/invite/mgr-link",
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Manager");
        await userEvent.type(screen.getByLabelText(/email/i), "mgr@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.MANAGER);
        await userEvent.selectOptions(screen.getByLabelText("Reporting HR admin"), "hr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(userService.inviteEmployee).toHaveBeenCalledWith(
            expect.objectContaining({ role: ROLES.MANAGER, managerId: "hr-1" })
        );
    });

    it("submits the invite, shows the returned invite link, and notifies the caller", async () => {
        const manager = makeUser({ id: "mgr-1", role: ROLES.MANAGER });
        userService.getUserOptions.mockResolvedValue([manager]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1" }),
            inviteLink: "http://localhost:5173/invite/abc123",
        });
        const onInvited = vi.fn();

        renderForm({ onInvited });
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/manager/i), "mgr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(userService.inviteEmployee).toHaveBeenCalledWith(
            expect.objectContaining({
                firstName: "New",
                lastName: "Hire",
                email: "new@example.com",
                managerId: "mgr-1",
            })
        );
        expect(await screen.findByText(/abc123/)).toBeInTheDocument();
        expect(onInvited).toHaveBeenCalledTimes(1);
    });

    // The link is emailed now, so the success panel has two shapes and the
    // server's `emailSent` picks between them — the failure shape is what the
    // test above already exercises (its mock omits the flag, as an older
    // server or a failed send would).
    it("confirms the invite was emailed, keeping the link as a fallback", async () => {
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "mgr-1", role: ROLES.MANAGER })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1", email: "new@example.com" }),
            inviteLink: "http://localhost:5173/invite/abc123",
            emailSent: true,
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/manager/i), "mgr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByText(/we emailed the link to new@example.com/i)).toBeInTheDocument();
        // Still copyable — the fallback for an email that never lands.
        expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });

    // A resend is the same request with a different outcome, so the panel has
    // to say which one happened — and, more importantly, that the details typed
    // into the form were not applied (the server reissues against the stored
    // row). Without that line HR has no way to know their edit was ignored.
    it("says an invitation was resent, and that the typed details were not applied", async () => {
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "mgr-1", role: ROLES.MANAGER })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1", email: "pending@example.com" }),
            inviteLink: "http://localhost:5173/invite/fresh456",
            emailSent: true,
            reissued: true,
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "pending@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/manager/i), "mgr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByText(/invitation resent/i)).toBeInTheDocument();
        expect(screen.getByText(/previous link stopped working/i)).toBeInTheDocument();
        expect(screen.getByText(/existing name, role and reporting line were kept/i)).toBeInTheDocument();
        expect(screen.getByText(/fresh456/)).toBeInTheDocument();
    });

    it("says nothing about resending for an ordinary first invite", async () => {
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "mgr-1", role: ROLES.MANAGER })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1", email: "new@example.com" }),
            inviteLink: "http://localhost:5173/invite/abc123",
            emailSent: true,
            reissued: false,
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/manager/i), "mgr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByText(/we emailed the link to new@example.com/i)).toBeInTheDocument();
        expect(screen.queryByText(/resent/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/were kept/i)).not.toBeInTheDocument();
    });

    it("warns when the server couldn't build an invite link at all", async () => {
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "mgr-1", role: ROLES.MANAGER })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1" }),
            inviteLink: null,
            emailSent: false,
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/manager/i), "mgr-1");
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByText(/invite link couldn't be built/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
    });

    it("copies the invite link to the clipboard", async () => {
        // Includes the inviter's own HR record — findAllUsers() always would
        // in real data, and the HR-admin reporting-line picker defaults to
        // selecting the inviter themself, which needs a matching option.
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "hr-viewer", role: ROLES.HR_ADMIN })]);
        userService.inviteEmployee.mockResolvedValue({
            user: makeUser({ id: "new-1" }),
            inviteLink: "http://localhost:5173/invite/abc123",
        });
        const writeText = vi.fn().mockResolvedValue();
        Object.assign(navigator, { clipboard: { writeText } });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "new@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));
        await screen.findByText(/abc123/);

        await userEvent.click(screen.getByRole("button", { name: /^copy$/i }));

        expect(writeText).toHaveBeenCalledWith("http://localhost:5173/invite/abc123");
        expect(await screen.findByRole("button", { name: /^copied$/i })).toBeInTheDocument();
    });

    it("rejects an email the browser would accept but the server won't", async () => {
        // Includes the inviter's own HR record — findAllUsers() always would
        // in real data, and the HR-admin reporting-line picker defaults to
        // selecting the inviter themself, which needs a matching option.
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "hr-viewer", role: ROLES.HR_ADMIN })]);
        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "Viraj");
        await userEvent.type(screen.getByLabelText(/last name/i), "Kumar");
        // type="email" considers a dot-less domain valid; the server does not.
        await userEvent.type(screen.getByLabelText(/email/i), "viraj@123");
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address");
        expect(userService.inviteEmployee).not.toHaveBeenCalled();
    });

    it("shows the server's field-level detail rather than a bare 'Validation failed'", async () => {
        // Includes the inviter's own HR record — findAllUsers() always would
        // in real data, and the HR-admin reporting-line picker defaults to
        // selecting the inviter themself, which needs a matching option.
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "hr-viewer", role: ROLES.HR_ADMIN })]);
        userService.inviteEmployee.mockRejectedValue({
            response: {
                status: 422,
                data: {
                    message: "Validation failed",
                    errors: [{ field: "email", message: "Enter a valid email address" }],
                },
            },
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "Viraj");
        await userEvent.type(screen.getByLabelText(/last name/i), "Kumar");
        await userEvent.type(screen.getByLabelText(/email/i), "viraj@example.com");
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Enter a valid email address");
        expect(alert).not.toHaveTextContent("Validation failed");
    });

    it("surfaces a failed invite without clearing the form", async () => {
        // Includes the inviter's own HR record — findAllUsers() always would
        // in real data, and the HR-admin reporting-line picker defaults to
        // selecting the inviter themself, which needs a matching option.
        userService.getUserOptions.mockResolvedValue([makeUser({ id: "hr-viewer", role: ROLES.HR_ADMIN })]);
        userService.inviteEmployee.mockRejectedValue({
            response: { data: { message: "Email already in use" } },
        });

        renderForm();
        await screen.findByLabelText(/first name/i);

        await userEvent.type(screen.getByLabelText(/first name/i), "New");
        await userEvent.type(screen.getByLabelText(/last name/i), "Hire");
        await userEvent.type(screen.getByLabelText(/email/i), "taken@example.com");
        // HR admin defaults the reporting line to the inviter themself, so
        // this stays focused on the error path without an extra selection.
        await userEvent.selectOptions(screen.getByLabelText(/role/i), ROLES.HR_ADMIN);
        await userEvent.click(screen.getByRole("button", { name: /^invite$/i }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Email already in use");
        expect(screen.getByLabelText(/first name/i)).toHaveValue("New");
    });
});
