import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAuthValue } from "../../tests/renderWithProviders.jsx";
import { TeamRequestList } from "./TeamRequestList.jsx";
import { ROLES } from "../../constants/roles.js";
import * as leaveRequestService from "../../services/leaveRequestService.js";
import * as leaveBalanceService from "../../services/leaveBalanceService.js";

vi.mock("../../services/leaveRequestService.js");
vi.mock("../../services/leaveBalanceService.js");

function makeRequest(overrides = {}) {
    return {
        id: "req-1",
        employee_first_name: "Asha",
        employee_last_name: "Employee",
        employee_role: "EMPLOYEE",
        leave_type_name: "Annual Leave",
        status: "SUBMITTED",
        start_date: "2099-01-06",
        end_date: "2099-01-06",
        working_days: "1.0",
        reason: "Trip",
        ...overrides,
    };
}

describe("TeamRequestList", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        leaveBalanceService.getUserBalances.mockResolvedValue([]);
    });

    it("offers approve/reject on a pending request, but not on a decided one", () => {
        renderWithProviders(<TeamRequestList requests={[makeRequest()]} canOverride={false} onChanged={vi.fn()} />);
        expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    });

    it("shows the employee's role next to their name", () => {
        renderWithProviders(
            <TeamRequestList requests={[makeRequest({ employee_role: "MANAGER" })]} canOverride={false} onChanged={vi.fn()} />
        );
        expect(screen.getByText("Manager")).toBeInTheDocument();
    });

    it("hides approve/reject and override for a manager without override rights on a decided request", () => {
        renderWithProviders(
            <TeamRequestList requests={[makeRequest({ status: "APPROVED" })]} canOverride={false} onChanged={vi.fn()} />
        );
        expect(screen.queryByRole("button", { name: /approve|reject|override/i })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^details$/i })).toBeInTheDocument();
    });

    it("offers HR override in the direction that makes sense for each status", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ id: "a", status: "APPROVED" }), makeRequest({ id: "b", status: "REJECTED" })]}
                canOverride
                onChanged={vi.fn()}
            />
        );
        expect(screen.getByRole("button", { name: /override to rejected/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /override to approved/i })).toBeInTheDocument();
    });

    it("approves a request with one click", async () => {
        leaveRequestService.approveLeaveRequest.mockResolvedValue({});
        const onChanged = vi.fn();
        renderWithProviders(<TeamRequestList requests={[makeRequest()]} canOverride={false} onChanged={onChanged} />);

        await userEvent.click(screen.getByRole("button", { name: /^approve$/i }));

        expect(leaveRequestService.approveLeaveRequest).toHaveBeenCalledWith("req-1");
        expect(onChanged).toHaveBeenCalled();
    });

    it("opens a comment box for rejecting and submits it with the rejection", async () => {
        leaveRequestService.rejectLeaveRequest.mockResolvedValue({});
        const onChanged = vi.fn();
        renderWithProviders(<TeamRequestList requests={[makeRequest()]} canOverride={false} onChanged={onChanged} />);

        await userEvent.click(screen.getByRole("button", { name: /^reject$/i }));
        await userEvent.type(screen.getByPlaceholderText(/reason for rejecting/i), "Team is short-staffed");
        await userEvent.click(screen.getByRole("button", { name: /confirm reject/i }));

        expect(leaveRequestService.rejectLeaveRequest).toHaveBeenCalledWith("req-1", "Team is short-staffed");
        expect(onChanged).toHaveBeenCalled();
    });

    it("overrides a rejected request back to approved when HR clicks the override control", async () => {
        leaveRequestService.overrideLeaveRequest.mockResolvedValue({});
        const onChanged = vi.fn();
        renderWithProviders(
            <TeamRequestList requests={[makeRequest({ status: "REJECTED" })]} canOverride onChanged={onChanged} />
        );

        await userEvent.click(screen.getByRole("button", { name: /override to approved/i }));
        await userEvent.type(screen.getByPlaceholderText(/reason for overriding/i), "Reconsidered");
        await userEvent.click(screen.getByRole("button", { name: /confirm override/i }));

        expect(leaveRequestService.overrideLeaveRequest).toHaveBeenCalledWith("req-1", "APPROVED", "Reconsidered");
        expect(onChanged).toHaveBeenCalled();
    });

    it("opens the details modal automatically for a notification-driven autoOpenRequestId, unlike a plain selectedRequestId", async () => {
        leaveRequestService.getLeaveRequestAuditTrail.mockResolvedValue([]);
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ id: "req-1" }), makeRequest({ id: "req-2" })]}
                canOverride={false}
                onChanged={vi.fn()}
                selectedRequestId="req-1"
                autoOpenRequestId="req-2"
            />
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(leaveRequestService.getLeaveRequestAuditTrail).toHaveBeenCalledWith("req-2");
    });

    it("doesn't open the details modal just from a calendar-driven selectedRequestId", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ id: "req-1" })]}
                canOverride={false}
                onChanged={vi.fn()}
                selectedRequestId="req-1"
            />
        );

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens the details modal and loads history when Details is clicked", async () => {
        leaveRequestService.getLeaveRequestAuditTrail.mockResolvedValue([
            {
                id: "a1",
                action: "SUBMIT",
                actor_first_name: "Priya",
                actor_last_name: "Manager",
                acted_for: null,
                comment: null,
                created_at: "2030-01-05T09:00:00Z",
            },
        ]);
        renderWithProviders(<TeamRequestList requests={[makeRequest()]} canOverride={false} onChanged={vi.fn()} />);

        await userEvent.click(screen.getByRole("button", { name: /^details$/i }));

        expect(leaveRequestService.getLeaveRequestAuditTrail).toHaveBeenCalledWith("req-1");
        expect(await screen.findByText("Priya Manager")).toBeInTheDocument();
    });

    it("doesn't show a delegated badge for the viewer's own direct report", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ employee_manager_id: "mgr-1", manager_first_name: "Priya", manager_last_name: "Manager" })]}
                canOverride={false}
                onChanged={vi.fn()}
            />,
            { authValue: makeAuthValue({ user: { id: "mgr-1", role: ROLES.MANAGER } }) }
        );
        expect(screen.queryByText(/delegated for/i)).not.toBeInTheDocument();
    });

    it("shows a delegated badge naming the covered manager when the row belongs to a manager the viewer is only standing in for", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ employee_manager_id: "mgr-1", manager_first_name: "Priya", manager_last_name: "Manager" })]}
                canOverride={false}
                onChanged={vi.fn()}
            />,
            { authValue: makeAuthValue({ user: { id: "delegate-1", role: ROLES.EMPLOYEE } }) }
        );
        expect(screen.getByText(/delegated for priya manager/i)).toBeInTheDocument();
    });

    // Escalated rows are the one case where HR legitimately sees approve/reject
    // on someone else's report, so the row has to say why — otherwise it reads
    // as a permissions bug from either side.
    it("shows an escalated badge on a request routed past the manager to HR", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ hr_escalated: true, employee_manager_id: "mgr-1" })]}
                canOverride={false}
                onChanged={vi.fn()}
            />,
            { authValue: makeAuthValue({ user: { id: "hr-1", role: ROLES.HR_ADMIN } }) }
        );
        expect(screen.getByText(/escalated to hr/i)).toBeInTheDocument();
    });

    it("shows no escalated badge on an ordinary request", () => {
        renderWithProviders(
            <TeamRequestList requests={[makeRequest()]} canOverride={false} onChanged={vi.fn()} />
        );
        expect(screen.queryByText(/escalated to hr/i)).not.toBeInTheDocument();
    });

    it("highlights the request selected from the team calendar, and no other", () => {
        renderWithProviders(
            <TeamRequestList
                requests={[makeRequest({ id: "req-1" }), makeRequest({ id: "req-2" })]}
                canOverride={false}
                onChanged={vi.fn()}
                selectedRequestId="req-2"
            />
        );

        const items = screen.getAllByRole("listitem");
        expect(items[0]).not.toHaveClass("ring-indigo-300");
        expect(items[1]).toHaveClass("ring-indigo-300");
    });

    describe("readOnly", () => {
        it("shows no approve/reject/override actions regardless of status, only Details", () => {
            renderWithProviders(
                <TeamRequestList
                    requests={[makeRequest({ id: "a", status: "SUBMITTED" }), makeRequest({ id: "b", status: "APPROVED" })]}
                    canOverride
                    onChanged={vi.fn()}
                    readOnly
                />
            );
            expect(screen.queryByRole("button", { name: /approve|reject|override/i })).not.toBeInTheDocument();
            expect(screen.getAllByRole("button", { name: /^details$/i })).toHaveLength(2);
        });

        it("doesn't show a delegated badge either, since every row's manager differs from an HR viewer as a matter of course", () => {
            renderWithProviders(
                <TeamRequestList
                    requests={[
                        makeRequest({ employee_manager_id: "mgr-1", manager_first_name: "Priya", manager_last_name: "Manager" }),
                    ]}
                    canOverride
                    onChanged={vi.fn()}
                    readOnly
                />,
                { authValue: makeAuthValue({ user: { id: "hr-1", role: ROLES.HR_ADMIN } }) }
            );
            expect(screen.queryByText(/delegated for/i)).not.toBeInTheDocument();
        });
    });
});
