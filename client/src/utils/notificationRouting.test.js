import { describe, it, expect } from "vitest";
import { getNotificationRoute } from "./notificationRouting.js";

describe("getNotificationRoute", () => {
    it("sends a decided leave request to My Leave, carrying the id as router state", () => {
        expect(getNotificationRoute({ type: "LEAVE_REQUEST_DECIDED", entity_id: "req-1" })).toEqual({
            pathname: "/dashboard/my-leave",
            state: { selectedRequestId: "req-1" },
        });
    });

    it("sends a submission or a withdrawal/cancellation to Approvals, the manager/HR-facing view", () => {
        expect(getNotificationRoute({ type: "LEAVE_REQUEST_SUBMITTED", entity_id: "req-2" })).toEqual({
            pathname: "/dashboard/approvals",
            state: { selectedRequestId: "req-2" },
        });
        expect(getNotificationRoute({ type: "LEAVE_REQUEST_WITHDRAWN_CANCELLED", entity_id: "req-3" })).toEqual({
            pathname: "/dashboard/approvals",
            state: { selectedRequestId: "req-3" },
        });
    });

    // The overdue-request sweep sends two notifications for one request, and
    // they must land on different pages: the manager decides, the employee
    // withdraws. Routing both to Approvals would bounce the employee to /403.
    it("splits the overdue sweep's two notifications between Approvals and My Leave", () => {
        expect(getNotificationRoute({ type: "LEAVE_REQUEST_OVERDUE", entity_id: "req-9" })).toEqual({
            pathname: "/dashboard/approvals",
            state: { selectedRequestId: "req-9" },
        });
        expect(getNotificationRoute({ type: "LEAVE_REQUEST_AWAITING_DECISION", entity_id: "req-9" })).toEqual({
            pathname: "/dashboard/my-leave",
            state: { selectedRequestId: "req-9" },
        });
    });

    it("sends a profile submission to HR's verification detail page for that employee", () => {
        expect(getNotificationRoute({ type: "PROFILE_SUBMITTED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile-verification/emp-1",
            state: null,
        });
    });

    it("sends a verified/sent-back profile to the employee's own profile page", () => {
        expect(getNotificationRoute({ type: "PROFILE_VERIFIED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
        expect(getNotificationRoute({ type: "PROFILE_SENT_BACK", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
    });

    it("sends a salary slip generated or voided notification to the salary slips page", () => {
        expect(getNotificationRoute({ type: "SALARY_SLIP_GENERATED", entity_id: "slip-1" })).toEqual({
            pathname: "/dashboard/salary-slips",
            state: null,
        });
        expect(getNotificationRoute({ type: "SALARY_SLIP_VOIDED", entity_id: "slip-1" })).toEqual({
            pathname: "/dashboard/salary-slips",
            state: null,
        });
    });

    it("sends a manager reassignment, salary structure update, or account status change to the employee's own profile page", () => {
        expect(getNotificationRoute({ type: "MANAGER_REASSIGNED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
        expect(getNotificationRoute({ type: "SALARY_STRUCTURE_UPDATED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
        expect(getNotificationRoute({ type: "ACCOUNT_STATUS_CHANGED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
    });

    it("sends a newly-created profile (right after accepting an invite) to the employee's own profile page", () => {
        expect(getNotificationRoute({ type: "PROFILE_CREATED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/profile",
            state: null,
        });
    });

    it("sends a new team member assignment to My Team", () => {
        expect(getNotificationRoute({ type: "TEAM_MEMBER_ASSIGNED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/team",
            state: null,
        });
    });

    it("sends a delegation nomination to the dashboard, since no dedicated delegate-facing page exists", () => {
        expect(getNotificationRoute({ type: "DELEGATION_NOMINATED", entity_id: "del-1" })).toEqual({
            pathname: "/dashboard",
            state: null,
        });
    });

    it("sends a delegation start/end notification to the manager's Delegations page", () => {
        expect(getNotificationRoute({ type: "DELEGATION_STARTED", entity_id: "del-1" })).toEqual({
            pathname: "/dashboard/delegations",
            state: null,
        });
        expect(getNotificationRoute({ type: "DELEGATION_ENDED", entity_id: "del-1" })).toEqual({
            pathname: "/dashboard/delegations",
            state: null,
        });
    });

    it("sends an accepted invite to My Team — All Employees is SUPER_ADMIN-only now", () => {
        expect(getNotificationRoute({ type: "INVITE_ACCEPTED", entity_id: "emp-1" })).toEqual({
            pathname: "/dashboard/team",
            state: null,
        });
    });

    it("falls back to the notifications page for an unrecognized type", () => {
        expect(getNotificationRoute({ type: "SOMETHING_NEW", entity_id: "x" })).toEqual({
            pathname: "/dashboard/notifications",
            state: null,
        });
    });
});
