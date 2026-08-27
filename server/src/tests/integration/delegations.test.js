import request from "supertest";
import app from "../../app.js";
import { describe, it, expect } from "vitest";
import { createUser, createLeaveType, createLeaveRequest } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

describe("Delegations", () => {
    it("requires authentication", async () => {
        const response = await request(app).get("/api/delegations/mine");
        expect(response.statusCode).toBe(401);
    });

    it("rejects a non-manager caller", async () => {
        const employee = await createUser({ email: "deleg-employee@example.com" });
        const agent = await loginAs(employee);

        const response = await agent.get("/api/delegations/mine");
        expect(response.statusCode).toBe(403);
    });

    it("lets a manager nominate a delegate and list it back", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-manager@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-delegate@example.com" });
        const agent = await loginAs(manager);

        const created = await agent
            .post("/api/delegations")
            .send({ delegateId: delegate.id, startDate: "2027-06-01", endDate: "2027-06-14" });

        expect(created.statusCode).toBe(201);
        expect(created.body.data.delegate_id).toBe(delegate.id);
        expect(created.body.data.manager_id).toBe(manager.id);

        const list = await agent.get("/api/delegations/mine");
        expect(list.body.data).toHaveLength(1);
        expect(list.body.data[0].id).toBe(created.body.data.id);
    });

    it("rejects delegating to yourself", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-self@example.com" });
        const agent = await loginAs(manager);

        const response = await agent
            .post("/api/delegations")
            .send({ delegateId: manager.id, startDate: "2027-06-01", endDate: "2027-06-14" });

        expect(response.statusCode).toBe(400);
    });

    it("rejects a delegation that overlaps one this manager already has", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-overlap-manager@example.com" });
        const delegateA = await createUser({ role: "MANAGER", email: "deleg-overlap-a@example.com" });
        const delegateB = await createUser({ role: "MANAGER", email: "deleg-overlap-b@example.com" });
        const agent = await loginAs(manager);

        await agent.post("/api/delegations").send({
            delegateId: delegateA.id,
            startDate: "2027-07-01",
            endDate: "2027-07-10",
        });

        const response = await agent.post("/api/delegations").send({
            delegateId: delegateB.id,
            startDate: "2027-07-05",
            endDate: "2027-07-20",
        });

        expect(response.statusCode).toBe(409);
    });

    it("only lists the requesting manager's own delegations, not another manager's", async () => {
        const managerA = await createUser({ role: "MANAGER", email: "deleg-list-a@example.com" });
        const managerB = await createUser({ role: "MANAGER", email: "deleg-list-b@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-list-delegate@example.com" });

        const agentA = await loginAs(managerA);
        await agentA.post("/api/delegations").send({ delegateId: delegate.id, startDate: "2027-08-01", endDate: "2027-08-05" });

        const agentB = await loginAs(managerB);
        const response = await agentB.get("/api/delegations/mine");

        expect(response.body.data).toHaveLength(0);
    });

    describe("GET /api/delegations/as-delegate", () => {
        it("requires authentication", async () => {
            const response = await request(app).get("/api/delegations/as-delegate");
            expect(response.statusCode).toBe(401);
        });

        // Deliberately not manager-gated, unlike every other route in this
        // file — a plain EMPLOYEE can be nominated as a delegate (nothing
        // checks the candidate's role in createDelegation) and needs this
        // endpoint to find out at all, since nothing else notifies them.
        it("lets a plain employee (not just a manager) see delegations nominating them", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-asdel-manager@example.com" });
            const employeeDelegate = await createUser({ email: "deleg-asdel-employee@example.com" });
            const managerAgent = await loginAs(manager);

            const created = await managerAgent
                .post("/api/delegations")
                .send({ delegateId: employeeDelegate.id, startDate: "2027-09-01", endDate: "2027-09-14" });
            expect(created.statusCode).toBe(201);

            const delegateAgent = await loginAs(employeeDelegate);
            const response = await delegateAgent.get("/api/delegations/as-delegate");

            expect(response.statusCode).toBe(200);
            expect(response.body.data).toHaveLength(1);
            expect(response.body.data[0]).toMatchObject({
                manager_id: manager.id,
                manager_first_name: manager.first_name,
                manager_last_name: manager.last_name,
                start_date: "2027-09-01",
                end_date: "2027-09-14",
            });
        });

        it("returns an empty list for someone nobody has delegated to", async () => {
            const employee = await createUser({ email: "deleg-asdel-none@example.com" });
            const agent = await loginAs(employee);

            const response = await agent.get("/api/delegations/as-delegate");

            expect(response.statusCode).toBe(200);
            expect(response.body.data).toEqual([]);
        });

        it("doesn't list delegations this user nominated themself as the manager", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-asdel-notmine@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-asdel-notmine-delegate@example.com" });
            const managerAgent = await loginAs(manager);

            await managerAgent
                .post("/api/delegations")
                .send({ delegateId: delegate.id, startDate: "2027-10-01", endDate: "2027-10-05" });

            const response = await managerAgent.get("/api/delegations/as-delegate");

            expect(response.body.data).toEqual([]);
        });
    });
    // Rules 1 and 4 of the delegation flow: a delegation and the delegate's own
    // leave are two claims on the same days, so the nomination is refused rather
    // than silently creating an approver who will not be there.
    describe("refusing a delegate whose own leave overlaps the window", () => {
        it("refuses a nomination overlapping the delegate's approved leave", async () => {
            const hr = await createUser({ role: "HR_ADMIN", email: "deleg-onleave-hr@example.com" });
            const manager = await createUser({ role: "MANAGER", managerId: hr.id, email: "deleg-onleave-mgr@example.com" });
            const delegate = await createUser({ managerId: manager.id, email: "deleg-onleave-delegate@example.com" });
            const leaveType = await createLeaveType({ annualEntitlement: 12 });

            const leave = await createLeaveRequest({
                employeeId: delegate.id,
                leaveTypeId: leaveType.id,
                startDate: "2027-09-06",
                endDate: "2027-09-08",
            });
            const managerAgent = await loginAs(manager);
            await managerAgent.post(`/api/leave-requests/${leave.id}/approve`).send({});

            const response = await managerAgent
                .post("/api/delegations")
                .send({ delegateId: delegate.id, startDate: "2027-09-07", endDate: "2027-09-10" });

            expect(response.statusCode).toBe(409);
            expect(response.body.message).toMatch(/approved leave/i);
            // The refusal names the colliding dates, so the manager's next
            // attempt isn't a guess.
            expect(response.body.message).toContain("2027-09-06");
        });

        it("refuses a nomination overlapping a leave request the delegate has only submitted", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-pending-mgr@example.com" });
            const delegate = await createUser({ managerId: manager.id, email: "deleg-pending-delegate@example.com" });
            const leaveType = await createLeaveType({ annualEntitlement: 12 });

            await createLeaveRequest({
                employeeId: delegate.id,
                leaveTypeId: leaveType.id,
                startDate: "2027-09-20",
                endDate: "2027-09-22",
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .post("/api/delegations")
                .send({ delegateId: delegate.id, startDate: "2027-09-21", endDate: "2027-09-24" });

            expect(response.statusCode).toBe(409);
            expect(response.body.message).toMatch(/pending leave request/i);
        });

        it("allows a nomination when the delegate's overlapping request was withdrawn", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-withdrawn-mgr@example.com" });
            const delegate = await createUser({ managerId: manager.id, email: "deleg-withdrawn-delegate@example.com" });
            const leaveType = await createLeaveType({ annualEntitlement: 12 });

            const leave = await createLeaveRequest({
                employeeId: delegate.id,
                leaveTypeId: leaveType.id,
                startDate: "2027-10-11",
                endDate: "2027-10-13",
            });
            const delegateAgent = await loginAs(delegate);
            await delegateAgent.post(`/api/leave-requests/${leave.id}/withdraw`).send({});

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .post("/api/delegations")
                .send({ delegateId: delegate.id, startDate: "2027-10-11", endDate: "2027-10-15" });

            expect(response.statusCode).toBe(201);
        });

        it("allows a nomination whose window sits either side of the delegate's leave", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-clear-mgr@example.com" });
            const delegate = await createUser({ managerId: manager.id, email: "deleg-clear-delegate@example.com" });
            const leaveType = await createLeaveType({ annualEntitlement: 12 });

            await createLeaveRequest({
                employeeId: delegate.id,
                leaveTypeId: leaveType.id,
                startDate: "2027-11-15",
                endDate: "2027-11-17",
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .post("/api/delegations")
                .send({ delegateId: delegate.id, startDate: "2027-11-18", endDate: "2027-11-25" });

            expect(response.statusCode).toBe(201);
        });
    });
});
