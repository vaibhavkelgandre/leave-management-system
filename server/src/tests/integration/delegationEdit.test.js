// PATCH /api/delegations/:id — a manager changing who covers their approvals,
// or when.
//
// The endpoint exists because the delegate a manager picked can stop being
// available after the fact: a delegate may book leave over a window that has
// not started yet, which is deliberately allowed and only notifies both sides.
// Before this, the manager had nowhere to go with that notification.
//
// Most fixtures here are today-relative, unlike delegations.test.js's fixed
// 2027 dates, because the central rule — an already-ended window can no longer
// be edited — is defined against the current date. Delegations have no
// working-day rule, so the weekend trap that fixed dates guard against
// elsewhere does not apply here (see helpers/dates.js).
import request from "supertest";
import app from "../../app.js";
import { describe, it, expect } from "vitest";
import { createUser, createLeaveType, createLeaveRequest, createDelegation } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { todayDateKey, addDaysToDateKey } from "../../utils/dates.js";

const day = (offset) => addDaysToDateKey(todayDateKey(), offset);

// Reads a recipient's own notifications through the API, as the recipient —
// the same way notifications.test.js asserts, rather than querying the table
// directly, so these also pin that the notification is actually deliverable.
async function notificationTypesFor(user) {
    const agent = await loginAs(user);
    const response = await agent.get("/api/notifications");
    return response.body.data.notifications.map((notification) => notification.type);
}

describe("Editing a delegation", () => {
    it("requires authentication", async () => {
        const response = await request(app)
            .patch("/api/delegations/00000000-0000-0000-0000-000000000000")
            .send({ startDate: day(3) });

        expect(response.statusCode).toBe(401);
    });

    it("rejects a non-manager caller", async () => {
        const employee = await createUser({ email: "deleg-edit-employee@example.com" });
        const agent = await loginAs(employee);

        const response = await agent
            .patch("/api/delegations/00000000-0000-0000-0000-000000000000")
            .send({ startDate: day(3) });

        expect(response.statusCode).toBe(403);
    });

    // 404 rather than 403: another manager's delegation is none of this
    // caller's business, and they have no more legitimate reason to learn one
    // exists than to learn the id was simply wrong (NFR-5).
    it("answers 404 for a delegation belonging to another manager", async () => {
        const owner = await createUser({ role: "MANAGER", email: "deleg-edit-owner@example.com" });
        const stranger = await createUser({ role: "MANAGER", email: "deleg-edit-stranger@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-owned-delegate@example.com" });

        const delegation = await createDelegation({
            managerId: owner.id,
            delegateId: delegate.id,
            startDate: day(2),
            endDate: day(6),
        });

        const strangerAgent = await loginAs(stranger);
        const response = await strangerAgent.patch(`/api/delegations/${delegation.id}`).send({ endDate: day(8) });

        expect(response.statusCode).toBe(404);
    });

    it("answers 404 for a delegation that does not exist", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-missing@example.com" });
        const agent = await loginAs(manager);

        const response = await agent
            .patch("/api/delegations/00000000-0000-0000-0000-000000000000")
            .send({ endDate: day(8) });

        expect(response.statusCode).toBe(404);
    });

    it("swaps the delegate, telling the outgoing one they are no longer covering", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-swap-mgr@example.com" });
        const outgoing = await createUser({ role: "MANAGER", email: "deleg-edit-swap-out@example.com" });
        const incoming = await createUser({ role: "MANAGER", email: "deleg-edit-swap-in@example.com" });

        const managerAgent = await loginAs(manager);
        const created = await managerAgent
            .post("/api/delegations")
            .send({ delegateId: outgoing.id, startDate: day(2), endDate: day(6) });
        expect(created.statusCode).toBe(201);

        const response = await managerAgent
            .patch(`/api/delegations/${created.body.data.id}`)
            .send({ delegateId: incoming.id });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.delegate_id).toBe(incoming.id);
        // The window is untouched — a swap resends no dates.
        expect(response.body.data.start_date).toBe(day(2));
        expect(response.body.data.end_date).toBe(day(6));

        // The row is edited in place, not superseded by a second one, so
        // "who is covering" stays a single answer.
        const list = await managerAgent.get("/api/delegations/mine");
        expect(list.body.data).toHaveLength(1);
        expect(list.body.data[0].delegate_id).toBe(incoming.id);

        expect(await notificationTypesFor(outgoing)).toContain("DELEGATION_REVOKED");
        // The incoming delegate hears about it as an ordinary nomination —
        // from their side that is exactly what it is.
        expect(await notificationTypesFor(incoming)).toContain("DELEGATION_NOMINATED");
    });

    it("notifies the delegate when only the dates move, and does not revoke them", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-dates-mgr@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-dates-delegate@example.com" });

        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: delegate.id,
            startDate: day(2),
            endDate: day(6),
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent.patch(`/api/delegations/${delegation.id}`).send({ endDate: day(9) });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.end_date).toBe(day(9));
        expect(response.body.data.delegate_id).toBe(delegate.id);

        const types = await notificationTypesFor(delegate);
        expect(types).toContain("DELEGATION_UPDATED");
        expect(types).not.toContain("DELEGATION_REVOKED");
    });

    // Regression guard for the overlap check: a row always overlaps itself, so
    // without excludeId every edit that left the dates alone would be refused
    // as clashing with the very row it is updating.
    it("does not treat the delegation being edited as an overlap with itself", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-selfoverlap-mgr@example.com" });
        const delegateA = await createUser({ role: "MANAGER", email: "deleg-edit-selfoverlap-a@example.com" });
        const delegateB = await createUser({ role: "MANAGER", email: "deleg-edit-selfoverlap-b@example.com" });

        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: delegateA.id,
            startDate: day(2),
            endDate: day(6),
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent
            .patch(`/api/delegations/${delegation.id}`)
            .send({ delegateId: delegateB.id, startDate: day(2), endDate: day(6) });

        expect(response.statusCode).toBe(200);
    });

    it("refuses a window overlapping another delegation of the same manager", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-overlap-mgr@example.com" });
        const delegateA = await createUser({ role: "MANAGER", email: "deleg-edit-overlap-a@example.com" });
        const delegateB = await createUser({ role: "MANAGER", email: "deleg-edit-overlap-b@example.com" });

        await createDelegation({
            managerId: manager.id,
            delegateId: delegateA.id,
            startDate: day(20),
            endDate: day(25),
        });
        const editable = await createDelegation({
            managerId: manager.id,
            delegateId: delegateB.id,
            startDate: day(2),
            endDate: day(6),
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent.patch(`/api/delegations/${editable.id}`).send({ endDate: day(22) });

        expect(response.statusCode).toBe(409);
    });

    // The same guard a nomination goes through — an edit that skipped it would
    // be a route to a state a create refuses.
    it("refuses a delegate whose own leave falls inside the new window", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-onleave-mgr@example.com" });
        const currentDelegate = await createUser({
            role: "MANAGER",
            email: "deleg-edit-onleave-current@example.com",
        });
        const busyDelegate = await createUser({
            managerId: manager.id,
            email: "deleg-edit-onleave-busy@example.com",
        });
        const leaveType = await createLeaveType({ annualEntitlement: 12 });

        await createLeaveRequest({
            employeeId: busyDelegate.id,
            leaveTypeId: leaveType.id,
            startDate: "2027-09-06",
            endDate: "2027-09-08",
        });

        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: currentDelegate.id,
            startDate: "2027-09-01",
            endDate: "2027-09-10",
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent
            .patch(`/api/delegations/${delegation.id}`)
            .send({ delegateId: busyDelegate.id });

        expect(response.statusCode).toBe(409);
        expect(response.body.message).toMatch(/2027-09-06/);
    });

    it("rejects reassigning the delegation to yourself", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-self-mgr@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-self-delegate@example.com" });

        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: delegate.id,
            startDate: day(2),
            endDate: day(6),
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent
            .patch(`/api/delegations/${delegation.id}`)
            .send({ delegateId: manager.id });

        expect(response.statusCode).toBe(400);
    });

    it("rejects a deactivated delegate", async () => {
        const manager = await createUser({ role: "MANAGER", email: "deleg-edit-inactive-mgr@example.com" });
        const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-inactive-a@example.com" });
        const deactivated = await createUser({
            role: "MANAGER",
            status: "INACTIVE",
            email: "deleg-edit-inactive-b@example.com",
        });

        const delegation = await createDelegation({
            managerId: manager.id,
            delegateId: delegate.id,
            startDate: day(2),
            endDate: day(6),
        });

        const managerAgent = await loginAs(manager);
        const response = await managerAgent
            .patch(`/api/delegations/${delegation.id}`)
            .send({ delegateId: deactivated.id });

        expect(response.statusCode).toBe(400);
    });

    describe("which delegations can still be changed", () => {
        it("allows editing a window that is already in progress", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-live-mgr@example.com" });
            const outgoing = await createUser({ role: "MANAGER", email: "deleg-edit-live-out@example.com" });
            const incoming = await createUser({ role: "MANAGER", email: "deleg-edit-live-in@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: outgoing.id,
                startDate: day(-2),
                endDate: day(5),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .patch(`/api/delegations/${delegation.id}`)
                .send({ delegateId: incoming.id });

            expect(response.statusCode).toBe(200);
            expect(response.body.data.delegate_id).toBe(incoming.id);
        });

        // The coverage already happened, and audit_logs records who acted for
        // whom during it — append-only. Rewriting the nomination afterwards
        // would contradict that trail while changing nothing about who may
        // approve anything now.
        it("refuses editing a window that has already ended", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-past-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-past-a@example.com" });
            const replacement = await createUser({ role: "MANAGER", email: "deleg-edit-past-b@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(-10),
                endDate: day(-1),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .patch(`/api/delegations/${delegation.id}`)
                .send({ delegateId: replacement.id });

            expect(response.statusCode).toBe(409);
            expect(response.body.message).toMatch(/already ended/i);
        });

        // Distinct from the 409 above: that one is about the *stored* row already
        // being frozen. This is a live delegation being edited into a window
        // that has already ended, which would leave a row granting nothing — the
        // same input a create refuses, so it gets the create's 400.
        //
        // Deliberately not treated as a way to end coverage early: this app has
        // no revoke, and a window that grants nothing is not the same record as
        // one that was withdrawn.
        it("refuses moving a live delegation into a window that has already ended", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-intopast-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-intopast-a@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(-3),
                endDate: day(5),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent.patch(`/api/delegations/${delegation.id}`).send({ endDate: day(-1) });

            expect(response.statusCode).toBe(400);
            expect(response.body.message).toMatch(/already ended/i);
        });

        it("still allows editing a window ending today", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-endstoday-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-endstoday-a@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(-3),
                endDate: day(0),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent.patch(`/api/delegations/${delegation.id}`).send({ endDate: day(4) });

            expect(response.statusCode).toBe(200);
        });
    });

    describe("validation", () => {
        it("rejects a body that changes nothing", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-empty-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-empty-a@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(2),
                endDate: day(6),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent.patch(`/api/delegations/${delegation.id}`).send({});

            expect(response.statusCode).toBe(422);
        });

        // The validator cannot catch this one: only `startDate` is supplied, so
        // the other half of the range comes from the stored row and the schema
        // never sees both together. The service compares the merged values.
        it("rejects a start date that inverts the stored window", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-invert-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-invert-a@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(2),
                endDate: day(6),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .patch(`/api/delegations/${delegation.id}`)
                .send({ startDate: day(20) });

            expect(response.statusCode).toBe(400);
        });

        it("rejects a malformed date", async () => {
            const manager = await createUser({ role: "MANAGER", email: "deleg-edit-baddate-mgr@example.com" });
            const delegate = await createUser({ role: "MANAGER", email: "deleg-edit-baddate-a@example.com" });

            const delegation = await createDelegation({
                managerId: manager.id,
                delegateId: delegate.id,
                startDate: day(2),
                endDate: day(6),
            });

            const managerAgent = await loginAs(manager);
            const response = await managerAgent
                .patch(`/api/delegations/${delegation.id}`)
                .send({ endDate: "next friday" });

            expect(response.statusCode).toBe(422);
        });
    });
});
