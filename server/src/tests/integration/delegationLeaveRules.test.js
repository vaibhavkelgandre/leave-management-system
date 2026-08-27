// The three delegation-vs-own-leave rules that live on the leave-request side,
// as opposed to the two on the nomination side (delegations.test.js):
//
//   1. Leave inside a delegation window the employee has already begun serving
//      is refused — they cannot be absent and covering an absent manager at once.
//   2. Leave overlapping a delegation window that has not started yet is allowed,
//      and both the delegate and the nominating manager are notified instead.
//   3. Leave submitted while covering approvals for the employee's *own* manager
//      is escalated: flagged hr_escalated, sent to HR, and decidable by HR
//      directly — which is otherwise impossible in this app.
//
// Every case here is genuinely "today"-relative (a delegation is active or not
// only with respect to the current date), so these use the date helpers rather
// than factories.js's fixed 2027 dates — see helpers/dates.js on why a narrow
// today-relative window fails on some day of the week.
import { describe, it, expect } from "vitest";
import { createUser, createLeaveType, createDelegation } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { leaveRangeCoveringToday, leaveRangeAfterToday } from "./helpers/dates.js";
import { todayDateKey, addDaysToDateKey } from "../../utils/dates.js";

const today = () => todayDateKey();

// A three-level branch: HR admin -> manager -> employee. The manager is the one
// who nominates (the route is MANAGER-only) and the HR admin is who an escalated
// request lands with, so every test here needs all three.
async function createBranch(prefix) {
    const hr = await createUser({ role: "HR_ADMIN", email: `${prefix}-hr@example.com` });
    const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: `${prefix}-mgr@example.com` });
    const employee = await createUser({ managerId: manager.id, email: `${prefix}-emp@example.com` });
    const leaveType = await createLeaveType({ annualEntitlement: 20 });
    return { hr, manager, employee, leaveType };
}

function submitLeave(agent, { leaveType, startDate, endDate }) {
    return agent.post("/api/leave-requests").send({
        leaveTypeId: leaveType.id,
        startDate,
        endDate,
        reason: "Delegation rule test",
    });
}

describe("Leave requests vs an active delegation", () => {
    it("refuses leave that falls inside a delegation window the employee is already serving", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-active-refuse");
        // Starts today, so it is already being served rather than upcoming.
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 10),
        });

        const agent = await loginAs(employee);
        const response = await submitLeave(agent, { leaveType, ...leaveRangeCoveringToday() });

        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/covering approvals/i);
        // The refusal has to say when they *can* book, or "you are a delegate"
        // leaves them with nowhere to go.
        expect(response.body.message).toContain(addDaysToDateKey(today(), 10));
    });

    it("allows leave for dates after the delegation window ends", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-active-after");
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 3),
        });

        const agent = await loginAs(employee);
        const response = await submitLeave(agent, { leaveType, ...leaveRangeAfterToday(20) });

        expect(response.statusCode).toBe(201);
    });

    it("does not constrain leave over a delegation window that has already passed", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-expired");
        // Wholly in the past: never active again, so it constrains nothing.
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: addDaysToDateKey(today(), -20),
            endDate: addDaysToDateKey(today(), -10),
        });

        const agent = await loginAs(employee);
        const response = await submitLeave(agent, { leaveType, ...leaveRangeCoveringToday() });

        expect(response.statusCode).toBe(201);
    });
});

describe("Leave requests vs an upcoming delegation", () => {
    it("allows the leave and notifies both the delegate and the nominating manager", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-upcoming");
        const window = leaveRangeAfterToday(20);
        // Starts in the future, so it is a warning rather than a refusal.
        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: window.startDate,
            endDate: addDaysToDateKey(window.endDate, 2),
        });

        const employeeAgent = await loginAs(employee);
        const response = await submitLeave(employeeAgent, { leaveType, ...window });
        expect(response.statusCode).toBe(201);

        const employeeNotifications = await employeeAgent.get("/api/notifications");
        const delegateNotice = employeeNotifications.body.data.notifications.find(
            (item) => item.type === "DELEGATION_LEAVE_CONFLICT"
        );
        expect(delegateNotice).toBeTruthy();
        expect(delegateNotice.entity_id).toBe(delegation.id);
        expect(delegateNotice.message).toMatch(/contact your manager/i);

        const managerAgent = await loginAs(manager);
        const managerNotifications = await managerAgent.get("/api/notifications");
        const managerNotice = managerNotifications.body.data.notifications.find(
            (item) => item.type === "DELEGATION_LEAVE_CONFLICT"
        );
        expect(managerNotice).toBeTruthy();
        expect(managerNotice.message).toMatch(/your delegate/i);
    });

    it("leaves the request on the ordinary manager-decides path", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-upcoming-notescalated");
        const window = leaveRangeAfterToday(20);
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: window.startDate,
            endDate: window.endDate,
        });

        const agent = await loginAs(employee);
        const response = await submitLeave(agent, { leaveType, ...window });

        // Nothing is being covered yet, so the manager is present and decides.
        expect(response.body.data.hr_escalated).toBe(false);
    });
});

describe("Escalating a delegate's own leave request to HR", () => {
    it("flags the request and lets HR decide it directly", async () => {
        const { hr, manager, employee, leaveType } = await createBranch("deleg-escalate");
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const employeeAgent = await loginAs(employee);
        const submitted = await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });
        expect(submitted.statusCode).toBe(201);
        expect(submitted.body.data.hr_escalated).toBe(true);

        // HR is not this employee's manager, and could not normally take the
        // first decision at all — the escalation is what permits it.
        const hrAgent = await loginAs(hr);
        const approved = await hrAgent.post(`/api/leave-requests/${submitted.body.data.id}/approve`).send({});

        expect(approved.statusCode).toBe(200);
        expect(approved.body.data.status).toBe("APPROVED");

        // Recorded as acting for the absent manager, not as HR overruling them.
        const audit = await hrAgent.get(`/api/leave-requests/${submitted.body.data.id}/audit`);
        const approveEntry = audit.body.data.find((entry) => entry.action === "APPROVE");
        expect(approveEntry.actor_id).toBe(hr.id);
        expect(approveEntry.acted_for).toBe(manager.id);
    });

    it("notifies HR instead of the away manager", async () => {
        const { hr, manager, employee, leaveType } = await createBranch("deleg-escalate-notify");
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const employeeAgent = await loginAs(employee);
        await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });

        const hrAgent = await loginAs(hr);
        const hrNotifications = await hrAgent.get("/api/notifications");
        const escalated = hrNotifications.body.data.notifications.find(
            (item) => item.type === "LEAVE_REQUEST_SUBMITTED"
        );
        expect(escalated).toBeTruthy();
        expect(escalated.message).toMatch(/covering approvals/i);

        const managerAgent = await loginAs(manager);
        const managerNotifications = await managerAgent.get("/api/notifications");
        expect(
            managerNotifications.body.data.notifications.some((item) => item.type === "LEAVE_REQUEST_SUBMITTED")
        ).toBe(false);
    });

    it("counts an escalated request in HR's pending-decisions badge", async () => {
        const { hr, manager, employee, leaveType } = await createBranch("deleg-escalate-count");
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const employeeAgent = await loginAs(employee);
        await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });

        const hrAgent = await loginAs(hr);
        const count = await hrAgent.get("/api/leave-requests/pending-count");

        // Without the escalated half of the count this reads 0 while HR has an
        // approval waiting: the request's assigned manager is not HR.
        expect(count.body.data.count).toBe(1);
    });

    it("still lets the manager decide their own escalated request", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-escalate-mgr");
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const employeeAgent = await loginAs(employee);
        const submitted = await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });

        // Escalation adds a decider; it does not move ownership away from the
        // manager, who can still act once they are back.
        const managerAgent = await loginAs(manager);
        const rejected = await managerAgent
            .post(`/api/leave-requests/${submitted.body.data.id}/reject`)
            .send({ comment: "Back now, declining" });

        expect(rejected.statusCode).toBe(200);
        expect(rejected.body.data.status).toBe("REJECTED");
    });

    it("does not escalate when the delegation is for a manager other than the employee's own", async () => {
        const { employee, leaveType } = await createBranch("deleg-other-mgr");
        const otherManager = await createUser({ role: "MANAGER", email: "deleg-other-mgr-other@example.com" });
        // Covering somebody else's approvals says nothing about whether this
        // employee's own manager is available.
        await createDelegation({
            managerId: otherManager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const agent = await loginAs(employee);
        const response = await submitLeave(agent, { leaveType, ...leaveRangeAfterToday(20) });

        expect(response.body.data.hr_escalated).toBe(false);
    });

    it("still refuses HR a direct decision on an ordinary, non-escalated request", async () => {
        const { hr, employee, leaveType } = await createBranch("deleg-nonescalated-hr");

        const employeeAgent = await loginAs(employee);
        const submitted = await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });

        const hrAgent = await loginAs(hr);
        const response = await hrAgent.post(`/api/leave-requests/${submitted.body.data.id}/approve`).send({});

        // The escalation branch must not have widened HR's authority in general.
        expect(response.statusCode).toBe(403);
    });

    it("refuses an out-of-branch HR admin a decision on an escalated request", async () => {
        const { manager, employee, leaveType } = await createBranch("deleg-escalate-outsider");
        const outsiderHr = await createUser({ role: "HR_ADMIN", email: "deleg-escalate-other-branch-hr@example.com" });
        await createDelegation({
            managerId: manager.id,
            delegateId: employee.id,
            startDate: today(),
            endDate: addDaysToDateKey(today(), 5),
        });

        const employeeAgent = await loginAs(employee);
        const submitted = await submitLeave(employeeAgent, { leaveType, ...leaveRangeAfterToday(20) });

        const outsiderAgent = await loginAs(outsiderHr);
        const response = await outsiderAgent.post(`/api/leave-requests/${submitted.body.data.id}/approve`).send({});

        // Escalation is scope-checked, never role-checked alone — another
        // branch's HR admin is as much a stranger here as anywhere else.
        expect(response.statusCode).toBe(404);
    });
});
