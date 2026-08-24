// G8 and G9: what happens to existing records when a leave type's definition
// changes.
//
// Both were undefined rather than wrong — the code did something consistent,
// nobody had decided whether it was the right something, and neither outcome was
// visible to the person it affected.
//
//   G8: balance reads filtered on `lt.is_active = true`, so the moment HR
//       discontinued a type, every employee who had taken it lost all sight of
//       it. The ledger still held the days; "how many sick days did I take?"
//       simply became unanswerable from the app.
//
//   G9: `leave_balances.entitlement` is a snapshot taken when the row is
//       created, so raising a type's entitlement mid-year changed nothing for
//       anyone who already had a row — HR raised Annual Leave from 12 to 15 in
//       June and nobody got the extra days until January, with no indication of
//       that anywhere.
import { describe, it, expect } from "vitest";
import pool from "../../config/db.js";
import { createRootHr, createUser, createLeaveType, createLeaveRequest } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

const THIS_YEAR = new Date().getFullYear();

async function balances(agent) {
    const response = await agent.get("/api/leave-balances/me");
    expect(response.statusCode).toBe(200);
    return response.body.data;
}

describe("Discontinuing a leave type (G8)", () => {
    it("keeps a discontinued type visible to an employee who used it", async () => {
        const hr = await createRootHr({ email: "lifecycle-visible-hr@example.com" });
        const manager = await createUser({
            role: "MANAGER",
            managerId: hr.id,
            email: "lifecycle-visible-mgr@example.com",
        });
        const employee = await createUser({ managerId: manager.id, email: "lifecycle-visible-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Discontinued Leave", annualEntitlement: 12 });

        // Must be in the *current* year: /leave-balances/me defaults to it, so
        // activity in a different year leaves this year's row untouched and the
        // type correctly stays hidden. Three consecutive days always contain a
        // working day, whatever weekday the 14th happens to be.
        const request = await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: `${THIS_YEAR}-09-14`,
            endDate: `${THIS_YEAR}-09-16`,
        });
        await (await loginAs(manager)).post(`/api/leave-requests/${request.id}/approve`).send({}).expect(200);

        await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}/status`)
            .send({ isActive: false })
            .expect(200);

        // The days are still in the ledger, so hiding the type would make the
        // employee's own history unreadable — which is the defect, not the
        // deactivation.
        const employeeAgent = await loginAs(employee);
        const list = await balances(employeeAgent);
        const discontinued = list.find((row) => row.leave_type_name === "Discontinued Leave");

        expect(discontinued).toBeDefined();
        // Flagged so the client can badge it — an employee must not be offered a
        // type they can no longer request.
        expect(discontinued.leave_type_active).toBe(false);
    });

    it("hides a discontinued type the employee never used", async () => {
        const hr = await createRootHr({ email: "lifecycle-unused-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "lifecycle-unused-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Never Used Leave", annualEntitlement: 12 });

        // Seed the balance row, then discontinue without any activity on it.
        await balances(await loginAs(employee));
        await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}/status`)
            .send({ isActive: false })
            .expect(200);

        const list = await balances(await loginAs(employee));

        // Showing a discontinued type with a full untouched entitlement would
        // read as leave they could still take.
        expect(list.find((row) => row.leave_type_name === "Never Used Leave")).toBeUndefined();
    });

    it("tells HR how many requests are still awaiting a decision", async () => {
        const hr = await createRootHr({ email: "lifecycle-pending-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "lifecycle-pending-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Pending Leave", annualEntitlement: 12 });
        await createLeaveRequest({
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            startDate: `${THIS_YEAR + 1}-03-02`,
            endDate: `${THIS_YEAR + 1}-03-03`,
        });

        const response = await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}/status`)
            .send({ isActive: false });

        // Deactivating blocks new requests but not decisions on existing ones,
        // so the type vanishes from the picker while approvals keep landing.
        expect(response.body.data.pendingRequests).toBe(1);
        expect(response.body.message).toMatch(/still awaiting a decision/i);
    });

    it("reports nothing pending when reactivating", async () => {
        const hr = await createRootHr({ email: "lifecycle-reactivate-hr@example.com" });
        const leaveType = await createLeaveType({ name: "Reactivated Leave", annualEntitlement: 12 });
        const hrAgent = await loginAs(hr);
        await hrAgent.patch(`/api/leave-types/${leaveType.id}/status`).send({ isActive: false }).expect(200);

        const response = await hrAgent.patch(`/api/leave-types/${leaveType.id}/status`).send({ isActive: true });

        expect(response.body.data.pendingRequests).toBe(0);
        expect(response.body.message).not.toMatch(/awaiting a decision/i);
    });
});

describe("Editing an entitlement (G9)", () => {
    const definition = {
        name: "Entitlement Leave",
        annualEntitlement: 15,
        accrualType: "UPFRONT",
        allowNegativeBalance: false,
        requiresDocument: false,
        countsAsLop: false,
    };

    it("leaves existing balances alone by default", async () => {
        const hr = await createRootHr({ email: "entitle-default-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "entitle-default-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Entitlement Leave", annualEntitlement: 12 });
        await balances(await loginAs(employee)); // materialise the row at 12

        const response = await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}`)
            .send(definition);

        // The snapshot is deliberate — retroactively rewriting an entitlement
        // changes what people have already been shown — so the default must not
        // move it.
        expect(response.statusCode).toBe(200);
        expect(response.body.data.balancesUpdated).toBe(0);

        const list = await balances(await loginAs(employee));
        expect(Number(list.find((row) => row.leave_type_name === "Entitlement Leave").entitlement)).toBe(12);
    });

    it("applies to this year's balances when HR opts in, and says how many moved", async () => {
        const hr = await createRootHr({ email: "entitle-optin-hr@example.com" });
        const first = await createUser({ managerId: hr.id, email: "entitle-optin-a@example.com" });
        const second = await createUser({ managerId: hr.id, email: "entitle-optin-b@example.com" });
        const leaveType = await createLeaveType({ name: "Entitlement Leave", annualEntitlement: 12 });
        await balances(await loginAs(first));
        await balances(await loginAs(second));

        const response = await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}`)
            .send({ ...definition, applyToCurrentYear: true });

        // The silent divergence this fixes: without the opt-in, whoever already
        // had a row kept 12 all year while a later hire got 15.
        expect(response.body.data.balancesUpdated).toBe(2);
        expect(response.body.message).toMatch(/2 existing balance\(s\) updated/);

        const list = await balances(await loginAs(first));
        expect(Number(list.find((row) => row.leave_type_name === "Entitlement Leave").entitlement)).toBe(15);
    });

    it("counts only rows that actually changed", async () => {
        const hr = await createRootHr({ email: "entitle-nochange-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "entitle-nochange-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Entitlement Leave", annualEntitlement: 15 });
        await balances(await loginAs(employee)); // already 15

        const response = await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}`)
            .send({ ...definition, applyToCurrentYear: true });

        // "2 balances updated" should mean two people's numbers moved, not two
        // rows matched.
        expect(response.body.data.balancesUpdated).toBe(0);
    });

    it("does not touch a previous year's balances", async () => {
        const hr = await createRootHr({ email: "entitle-pastyear-hr@example.com" });
        const employee = await createUser({ managerId: hr.id, email: "entitle-pastyear-emp@example.com" });
        const leaveType = await createLeaveType({ name: "Entitlement Leave", annualEntitlement: 12 });
        await pool.query(
            `INSERT INTO leave_balances (user_id, leave_type_id, year, entitlement) VALUES ($1, $2, $3, 12)`,
            [employee.id, leaveType.id, THIS_YEAR - 1]
        );

        await (await loginAs(hr))
            .patch(`/api/leave-types/${leaveType.id}`)
            .send({ ...definition, applyToCurrentYear: true })
            .expect(200);

        // A past year records what people were entitled to then.
        const past = await pool.query(
            "SELECT entitlement FROM leave_balances WHERE user_id = $1 AND year = $2",
            [employee.id, THIS_YEAR - 1]
        );
        expect(Number(past.rows[0].entitlement)).toBe(12);
    });
});
