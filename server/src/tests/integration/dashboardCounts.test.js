// The count/slice endpoints behind the sidebar badge and the dashboard tile:
// GET /leave-requests/pending-count, GET /leave-requests/on-leave-today and
// GET /users/me/team/count.
//
// They exist for performance — each replaces a client that downloaded a whole
// list and derived one number from it (see the NFR-7 note in
// leaveRequestRepository.countPendingDecisionsForManagers) — but the thing
// worth testing is that they answer *the same question* the client used to
// answer for itself. A count that's fast and wrong is worse than the slow
// list it replaced, so every case here pins the scoping rule rather than the
// performance.
import request from "supertest";
import { describe, it, expect } from "vitest";
import app from "../../app.js";
import {
    createRootHr,
    createSuperAdmin,
    createUser,
    createLeaveType,
    createLeaveRequest,
    createDelegation,
} from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { leaveRangeCoveringToday, leaveRangeAfterToday } from "./helpers/dates.js";
import { todayDateKey, addDaysToDateKey } from "../../utils/dates.js";

async function pendingCount(agent) {
    const response = await agent.get("/api/leave-requests/pending-count");
    expect(response.statusCode).toBe(200);
    return response.body.data.count;
}

describe("GET /api/leave-requests/pending-count", () => {
    it("requires authentication", async () => {
        expect((await request(app).get("/api/leave-requests/pending-count")).statusCode).toBe(401);
    });

    it("counts a manager's own direct reports' SUBMITTED requests, and nothing else", async () => {
        const hr = await createRootHr({ email: "count-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "count-mgr@example.com" });
        const employee = await createUser({ managerId: manager.id, email: "count-emp@example.com" });
        // Another manager's report — same company, different team.
        const otherManager = await createUser({
            role: "MANAGER",
            managerId: hr.id,
            email: "count-other-mgr@example.com",
        });
        const otherEmployee = await createUser({ managerId: otherManager.id, email: "count-other-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Count Leave", annualEntitlement: 20 });

        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-03-01",
            endDate: "2032-03-02",
        });
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-04-01",
            endDate: "2032-04-02",
        });
        await createLeaveRequest({
            employeeId: otherEmployee.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-03-01",
            endDate: "2032-03-02",
        });

        expect(await pendingCount(await loginAs(manager))).toBe(2);
        expect(await pendingCount(await loginAs(otherManager))).toBe(1);
    });

    it("stops counting a request once it's decided", async () => {
        const hr = await createRootHr({ email: "count-decided-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "count-decided-mgr@example.com" });
        const employee = await createUser({ managerId: manager.id, email: "count-decided-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Count Decided Leave", annualEntitlement: 20 });
        const leaveRequest = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-05-03",
            endDate: "2032-05-04",
        });
        const managerAgent = await loginAs(manager);

        expect(await pendingCount(managerAgent)).toBe(1);

        await managerAgent.post(`/api/leave-requests/${leaveRequest.id}/approve`).send({});

        expect(await pendingCount(managerAgent)).toBe(0);
    });

    // The rule the client used to apply after downloading the rows
    // (canDecideDirectly): an HR admin's team list spans their whole branch,
    // but only the requests where HR *is* the assigned manager are theirs to
    // decide — badging them with the rest would be work that isn't theirs.
    it("counts only what HR is the assigned manager for, not their whole branch", async () => {
        const hr = await createRootHr({ email: "count-hrscope@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "count-hrscope-mgr@example.com" });
        const underManager = await createUser({ managerId: manager.id, email: "count-hrscope-deep@example.com" });
        const reportsToHr = await createUser({ managerId: hr.id, email: "count-hrscope-direct@example.com" });
        const leaveType = await createLeaveType({ name: "Count HR Leave", annualEntitlement: 20 });

        await createLeaveRequest({
            employeeId: underManager.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-06-01",
            endDate: "2032-06-02",
        });
        await createLeaveRequest({
            employeeId: reportsToHr.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-06-01",
            endDate: "2032-06-02",
        });

        // Both rows are inside HR's branch; only the second is HR's decision.
        expect(await pendingCount(await loginAs(hr))).toBe(1);
    });

    it("includes a manager's requests while an active delegation names the caller", async () => {
        const hr = await createRootHr({ email: "count-deleg-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "count-deleg-mgr@example.com" });
        const employee = await createUser({ managerId: manager.id, email: "count-deleg-emp@example.com" });
        const delegate = await createUser({ managerId: hr.id, email: "count-deleg-delegate@example.com" });
        const leaveType = await createLeaveType({ name: "Count Delegated Leave", annualEntitlement: 20 });
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: "2032-07-01",
            endDate: "2032-07-02",
        });

        const today = todayDateKey();
        const delegateAgent = await loginAs(delegate);
        expect(await pendingCount(delegateAgent)).toBe(0);

        await createDelegation({
            managerId: manager.id,
            delegateId: delegate.id,
            // Three consecutive days always contain a working day, whatever
            // day of the week it is — see helpers/dates.js on why anything
            // narrower needs one of the helpers there.
            startDate: addDaysToDateKey(today, -1),
            endDate: addDaysToDateKey(today, 1),
        });

        expect(await pendingCount(delegateAgent)).toBe(1);
    });

    it("is zero, not an error, for an employee with nobody reporting to them", async () => {
        const employee = await createUser({ email: "count-plain-emp@example.com" });
        expect(await pendingCount(await loginAs(employee))).toBe(0);
    });
});

describe("GET /api/leave-requests/on-leave-today", () => {
    it("requires authentication", async () => {
        expect((await request(app).get("/api/leave-requests/on-leave-today")).statusCode).toBe(401);
    });

    it("returns only approved leave overlapping today, within the caller's team", async () => {
        const hr = await createRootHr({ email: "today-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "today-mgr@example.com" });
        const outToday = await createUser({ managerId: manager.id, email: "today-out@example.com" });
        const outLater = await createUser({ managerId: manager.id, email: "today-later@example.com" });
        const pendingToday = await createUser({ managerId: manager.id, email: "today-pending@example.com" });
        const leaveType = await createLeaveType({ name: "Today Leave", annualEntitlement: 30 });
        const today = todayDateKey();
        const managerAgent = await loginAs(manager);

        const approved = await createLeaveRequest({
            employeeId: outToday.id,
            leaveTypeId: leaveType.id,
            // Three consecutive days always contain a working day, whatever
            // day of the week it is — see helpers/dates.js on why anything
            // narrower needs one of the helpers there.
            startDate: addDaysToDateKey(today, -1),
            endDate: addDaysToDateKey(today, 1),
        });
        await managerAgent.post(`/api/leave-requests/${approved.id}/approve`).send({});

        const future = await createLeaveRequest({
            employeeId: outLater.id,
            leaveTypeId: leaveType.id,
            ...leaveRangeAfterToday(10),
        });
        await managerAgent.post(`/api/leave-requests/${future.id}/approve`).send({});

        // Approved-today's neighbour: overlaps today, but never decided.
        await createLeaveRequest({
            employeeId: pendingToday.id,
            leaveTypeId: leaveType.id,
            ...leaveRangeCoveringToday(),
        });

        const response = await managerAgent.get("/api/leave-requests/on-leave-today");

        expect(response.statusCode).toBe(200);
        expect(response.body.data.map((row) => row.employee_id)).toEqual([outToday.id]);
    });

    it("is company-wide for SUPER_ADMIN and branch-scoped for HR", async () => {
        const superAdmin = await createSuperAdmin({ email: "today-super@example.com" });
        const hrA = await createRootHr({ email: "today-hrA@example.com" });
        const hrB = await createRootHr({ email: "today-hrB@example.com" });
        const employeeOfB = await createUser({ managerId: hrB.id, email: "today-emp-of-b@example.com" });
        const leaveType = await createLeaveType({ name: "Today Scope Leave", annualEntitlement: 30 });

        const approved = await createLeaveRequest({
            employeeId: employeeOfB.id,
            leaveTypeId: leaveType.id,
            ...leaveRangeCoveringToday(),
        });
        await (await loginAs(hrB)).post(`/api/leave-requests/${approved.id}/approve`).send({});

        // The super admin sees another branch's leave; hrA never does.
        const superResponse = await (await loginAs(superAdmin)).get("/api/leave-requests/on-leave-today");
        expect(superResponse.body.data.map((row) => row.employee_id)).toContain(employeeOfB.id);

        const hrAResponse = await (await loginAs(hrA)).get("/api/leave-requests/on-leave-today");
        expect(hrAResponse.body.data.map((row) => row.employee_id)).not.toContain(employeeOfB.id);
    });

    it("is an empty list, not an error, for an employee with no team", async () => {
        const employee = await createUser({ email: "today-plain@example.com" });
        const response = await (await loginAs(employee)).get("/api/leave-requests/on-leave-today");

        expect(response.statusCode).toBe(200);
        expect(response.body.data).toEqual([]);
    });
});

describe("GET /api/users/me/team/count", () => {
    it("requires authentication", async () => {
        expect((await request(app).get("/api/users/me/team/count")).statusCode).toBe(401);
    });

    // Must agree with GET /users/me/team's own length — the tile shows this
    // number beside a table built from that endpoint's scope.
    it("matches the size of the caller's own team list, excluding themselves", async () => {
        const hr = await createRootHr({ email: "size-hr@example.com" });
        const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "size-mgr@example.com" });
        await createUser({ managerId: manager.id, email: "size-emp-1@example.com" });
        await createUser({ managerId: manager.id, email: "size-emp-2@example.com" });
        await createUser({ managerId: hr.id, email: "size-emp-3@example.com" });

        const hrAgent = await loginAs(hr);
        const list = await hrAgent.get("/api/users/me/team");
        const count = await hrAgent.get("/api/users/me/team/count");

        expect(count.statusCode).toBe(200);
        expect(count.body.data.count).toBe(list.body.data.length);
        // manager + 2 of their reports + 1 reporting straight to HR
        expect(count.body.data.count).toBe(4);

        const managerCount = await (await loginAs(manager)).get("/api/users/me/team/count");
        expect(managerCount.body.data.count).toBe(2);
    });

    it("is zero for someone with no reports", async () => {
        const employee = await createUser({ email: "size-plain@example.com" });
        const response = await (await loginAs(employee)).get("/api/users/me/team/count");

        expect(response.body.data.count).toBe(0);
    });
});
