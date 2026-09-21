// PATCH /api/users/:id/role — promoting and demoting an existing account.
//
// The rules worth testing here are not "does the column change". They are the
// two consequences of role and authority being separate in this app: a role
// gates routes and reporting-line eligibility, while authority over a row
// comes from that row's `manager_id`. So a demotion that leaves reports
// pointing at the demoted account would keep their approval power alive, and a
// promotion to MANAGER can invalidate the promoted account's own reporting
// line (a MANAGER may only report to an HR_ADMIN). Both are refused, and both
// are pinned below.
//
// The authorization cases mirror userStatus.test.js deliberately: this
// endpoint shares changeManager/changeStatus's "creator, or in my HR scope"
// rule, and a divergence between the three is the bug most worth catching.
import { describe, it, expect } from "vitest";
import { createRootHr, createSuperAdmin, createUser } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import pool from "../../config/db.js";

describe("PATCH /api/users/:id/role", () => {
    it("promotes an employee to manager", async () => {
        const hr = await createRootHr({ email: "hr-promote@example.com" });
        const employee = await createUser({ email: "promote-me@example.com", managerId: hr.id, invitedBy: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${employee.id}/role`).send({ role: "MANAGER" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.role).toBe("MANAGER");
    });

    it("demotes a manager who has no reports", async () => {
        const hr = await createRootHr({ email: "hr-demote@example.com" });
        const manager = await createUser({
            email: "demote-me@example.com",
            role: "MANAGER",
            managerId: hr.id,
            invitedBy: hr.id,
        });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${manager.id}/role`).send({ role: "EMPLOYEE" });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.role).toBe("EMPLOYEE");
    });

    // The headline test. Without this refusal the demoted account keeps
    // approving its old team's leave, because decideLeaveRequest authorizes on
    // the request's `employee_manager_id`, which still points here.
    it("refuses to demote a manager who still has direct reports, naming them", async () => {
        const hr = await createRootHr({ email: "hr-strand@example.com" });
        const manager = await createUser({
            email: "still-has-team@example.com",
            role: "MANAGER",
            managerId: hr.id,
            invitedBy: hr.id,
        });
        await createUser({
            email: "report-one@example.com",
            firstName: "Asha",
            lastName: "Reporter",
            managerId: manager.id,
            invitedBy: hr.id,
        });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${manager.id}/role`).send({ role: "EMPLOYEE" });

        expect(response.statusCode).toBe(409);
        // Naming who is affected is the difference between a refusal HR can
        // act on and a dead end.
        expect(response.body.message).toContain("Asha Reporter");

        // And the demotion genuinely did not happen.
        const stillManager = await hrAgent.get(`/api/users/${manager.id}`);
        expect(stillManager.body.data.role).toBe("MANAGER");
    });

    // ALLOWED_MANAGER_ROLES.MANAGER is ["HR_ADMIN"], so this promotion would
    // leave a manager reporting to a manager. The merged state is what's
    // checked — the request body alone says nothing about the stored line.
    it("refuses to promote an employee to manager while they report to a manager", async () => {
        const hr = await createRootHr({ email: "hr-illegal-line@example.com" });
        const manager = await createUser({
            email: "their-manager@example.com",
            role: "MANAGER",
            managerId: hr.id,
            invitedBy: hr.id,
        });
        const employee = await createUser({
            email: "under-a-manager@example.com",
            managerId: manager.id,
            invitedBy: hr.id,
        });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${employee.id}/role`).send({ role: "MANAGER" });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/HR admin/i);
    });

    it("allows that same promotion when it supplies a valid manager in the same call", async () => {
        const hr = await createRootHr({ email: "hr-legal-line@example.com" });
        const manager = await createUser({
            email: "their-manager-2@example.com",
            role: "MANAGER",
            managerId: hr.id,
            invitedBy: hr.id,
        });
        const employee = await createUser({
            email: "under-a-manager-2@example.com",
            managerId: manager.id,
            invitedBy: hr.id,
        });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent
            .patch(`/api/users/${employee.id}/role`)
            .send({ role: "MANAGER", managerId: hr.id });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.role).toBe("MANAGER");
        // The reporting line moved in the same operation, not as a follow-up.
        expect(response.body.data.manager_id).toBe(hr.id);
    });

    // A role that requires a manager cannot be reached by clearing one, which
    // is otherwise a route to an employee nobody can approve leave for.
    it("refuses to demote a manager-less HR admin to employee with no manager given", async () => {
        const superAdmin = await createSuperAdmin({ email: "super-rolechange@example.com" });
        const hr = await createUser({
            email: "root-hr-to-demote@example.com",
            role: "HR_ADMIN",
            managerId: superAdmin.id,
            invitedBy: superAdmin.id,
        });
        const superAgent = await loginAs(superAdmin);

        const response = await superAgent
            .patch(`/api/users/${hr.id}/role`)
            .send({ role: "EMPLOYEE", managerId: null });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/must have a manager/i);
    });

    it("rejects a no-op change to the role the account already has", async () => {
        const hr = await createRootHr({ email: "hr-noop@example.com" });
        const employee = await createUser({ email: "noop-role@example.com", managerId: hr.id, invitedBy: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${employee.id}/role`).send({ role: "EMPLOYEE" });

        expect(response.statusCode).toBe(400);
    });

    it("refuses to let an HR admin change their own role", async () => {
        const hr = await createRootHr({ email: "hr-self-role@example.com" });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${hr.id}/role`).send({ role: "EMPLOYEE" });

        expect(response.statusCode).toBe(400);
    });

    // Demoting the root would be unrecoverable: registerHrRoot refuses to
    // create a second super admin.
    it("refuses to change the super admin's role", async () => {
        const superAdmin = await createSuperAdmin({ email: "super-untouchable@example.com" });
        const hr = await createUser({
            email: "hr-vs-super@example.com",
            role: "HR_ADMIN",
            managerId: superAdmin.id,
            invitedBy: superAdmin.id,
        });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${superAdmin.id}/role`).send({ role: "EMPLOYEE" });

        // 403 (out of this HR admin's scope) or 400 (the role itself is
        // protected) are both correct refusals; what matters is that it is
        // never allowed. The scope check runs first.
        expect([400, 403]).toContain(response.statusCode);
    });

    // The schema's enum is the guard, so this never reaches the service — and
    // that matters, because migration 038's partial unique index would
    // otherwise answer with a confusing unique-violation instead.
    it("refuses SUPER_ADMIN as a destination role at the validation layer", async () => {
        const hr = await createRootHr({ email: "hr-super-dest@example.com" });
        const employee = await createUser({ email: "wants-super@example.com", managerId: hr.id, invitedBy: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.patch(`/api/users/${employee.id}/role`).send({ role: "SUPER_ADMIN" });

        expect(response.statusCode).toBe(422);
    });

    it("rejects an HR admin who neither created the target nor has them in scope", async () => {
        const creatorHr = await createRootHr({ email: "hr-role-creator@example.com" });
        const otherHr = await createRootHr({ email: "hr-role-other@example.com" });
        const employee = await createUser({
            email: "role-not-mine@example.com",
            managerId: creatorHr.id,
            invitedBy: creatorHr.id,
        });
        const otherAgent = await loginAs(otherHr);

        const response = await otherAgent.patch(`/api/users/${employee.id}/role`).send({ role: "MANAGER" });

        expect(response.statusCode).toBe(403);
    });

    it("refuses a plain manager and a plain employee at the route gate", async () => {
        const hr = await createRootHr({ email: "hr-role-gate@example.com" });
        const manager = await createUser({
            email: "manager-tries-role@example.com",
            role: "MANAGER",
            managerId: hr.id,
            invitedBy: hr.id,
        });
        const employee = await createUser({
            email: "employee-tries-role@example.com",
            managerId: manager.id,
            invitedBy: hr.id,
        });

        const managerAgent = await loginAs(manager);
        const employeeAgent = await loginAs(employee);

        expect((await managerAgent.patch(`/api/users/${employee.id}/role`).send({ role: "MANAGER" })).statusCode).toBe(
            403
        );
        expect((await employeeAgent.patch(`/api/users/${manager.id}/role`).send({ role: "EMPLOYEE" })).statusCode).toBe(
            403
        );
    });

    // The point of the whole feature, and the reason no session handling was
    // needed: requireAuth re-reads the role from the database on every
    // request, so new permissions apply on the very next call rather than when
    // the 8-hour token expires.
    it("grants the new role's permissions to an existing session immediately", async () => {
        const hr = await createRootHr({ email: "hr-perm-change@example.com" });
        const employee = await createUser({ email: "about-to-be-hr@example.com", managerId: hr.id, invitedBy: hr.id });

        const hrAgent = await loginAs(hr);
        const employeeAgent = await loginAs(employee);

        // POST /users/invite is HR-tier gated, so this is a 403 today.
        const before = await employeeAgent
            .post("/api/users/invite")
            .send({ firstName: "No", lastName: "Chance", email: "nope@example.com", role: "EMPLOYEE", managerId: hr.id });
        expect(before.statusCode).toBe(403);

        const promotion = await hrAgent
            .patch(`/api/users/${employee.id}/role`)
            .send({ role: "HR_ADMIN", managerId: hr.id });
        expect(promotion.statusCode).toBe(200);

        // Same cookie, no re-login.
        const after = await employeeAgent.post("/api/users/invite").send({
            firstName: "Now",
            lastName: "Allowed",
            email: "now-allowed@example.com",
            role: "EMPLOYEE",
            managerId: employee.id,
        });
        expect(after.statusCode).toBe(201);
    });

    it("notifies the employee, naming their new role", async () => {
        const hr = await createRootHr({ email: "hr-role-notify@example.com" });
        const employee = await createUser({ email: "notify-role@example.com", managerId: hr.id, invitedBy: hr.id });
        const hrAgent = await loginAs(hr);

        await hrAgent.patch(`/api/users/${employee.id}/role`).send({ role: "MANAGER" });

        const { rows } = await pool.query(
            "SELECT type, message FROM notifications WHERE recipient_id = $1 AND type = 'ROLE_CHANGED'",
            [employee.id]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].message).toContain("Manager");
    });
});
