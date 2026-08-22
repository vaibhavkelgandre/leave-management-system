import request from "supertest";
import { describe, it, expect } from "vitest";
import app from "../../app.js";
import pool from "../../config/db.js";
import { createRootHr, createUser } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";

function extractToken(inviteLink) {
    return inviteLink.split("/invite/")[1];
}

describe("Invitation flow (FR-001)", () => {
    it("invites, verifies, accepts, then logs in", async () => {
        const hr = await createRootHr({ email: "hr@example.com" });
        const hrAgent = await loginAs(hr);

        const inviteResponse = await hrAgent.post("/api/users/invite").send({
            firstName: "New",
            lastName: "Hire",
            email: "newhire@example.com",
            role: "EMPLOYEE",
            managerId: hr.id,
        });

        expect(inviteResponse.statusCode).toBe(201);
        const { inviteLink } = inviteResponse.body.data;
        const token = extractToken(inviteLink);

        const verifyResponse = await request(app)
            .post("/api/auth/invitations/verify")
            .send({ token });

        expect(verifyResponse.statusCode).toBe(200);
        expect(verifyResponse.body.data.email).toBe("newhire@example.com");

        const acceptResponse = await request(app)
            .post("/api/auth/invitations/accept")
            .send({ token, password: "NewPassword123!" });

        expect(acceptResponse.statusCode).toBe(200);
        expect(acceptResponse.body.data.user.status).toBe("ACTIVE");

        const loginResponse = await request(app)
            .post("/api/auth/login")
            .send({ email: "newhire@example.com", password: "NewPassword123!" });

        expect(loginResponse.statusCode).toBe(200);

        const reuseResponse = await request(app)
            .post("/api/auth/invitations/accept")
            .send({ token, password: "AnotherPassword1!" });

        expect(reuseResponse.statusCode).toBe(401);
    });

    it("rejects invite from a non-HR user", async () => {
        const hr = await createRootHr({ email: "hr2@example.com" });
        const employee = await createUser({ email: "plainemployee@example.com", managerId: hr.id });
        const employeeAgent = await loginAs(employee);

        const response = await employeeAgent.post("/api/users/invite").send({
            firstName: "New",
            lastName: "Hire",
            email: "shouldnotexist@example.com",
            role: "EMPLOYEE",
            managerId: hr.id,
        });

        expect(response.statusCode).toBe(403);
    });

    it("allows inviting an HR_ADMIN with a managerId pointing to another HR_ADMIN — the new HR reports to whoever created them", async () => {
        const hr = await createRootHr({ email: "hr3@example.com" });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.post("/api/users/invite").send({
            firstName: "Second",
            lastName: "Hr",
            email: "secondhr@example.com",
            role: "HR_ADMIN",
            managerId: hr.id,
        });

        expect(response.statusCode).toBe(201);
        expect(response.body.data.user.manager_id).toBe(hr.id);
    });

    it("rejects inviting an HR_ADMIN with no managerId at all — it's required, same as for an employee", async () => {
        const hr = await createRootHr({ email: "hr4@example.com" });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.post("/api/users/invite").send({
            firstName: "Second",
            lastName: "Hr",
            email: "secondhr2@example.com",
            role: "HR_ADMIN",
        });

        expect(response.statusCode).toBe(422);
    });

    it("rejects inviting an HR_ADMIN whose manager is a MANAGER, not another HR_ADMIN", async () => {
        const hr = await createRootHr({ email: "hr7@example.com" });
        const manager = await createUser({ email: "mgr-for-hr7@example.com", role: "MANAGER", managerId: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.post("/api/users/invite").send({
            firstName: "Second",
            lastName: "Hr",
            email: "secondhr3@example.com",
            role: "HR_ADMIN",
            managerId: manager.id,
        });

        expect(response.statusCode).toBe(400);
    });

    it("rejects inviting a MANAGER whose manager is another MANAGER, not HR", async () => {
        const hr = await createRootHr({ email: "hr5@example.com" });
        const otherManager = await createUser({ email: "othermgr@example.com", role: "MANAGER", managerId: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.post("/api/users/invite").send({
            firstName: "New",
            lastName: "Manager",
            email: "newmanager@example.com",
            role: "MANAGER",
            managerId: otherManager.id,
        });

        expect(response.statusCode).toBe(400);
    });

    it("rejects inviting an EMPLOYEE whose manager is another EMPLOYEE", async () => {
        const hr = await createRootHr({ email: "hr6@example.com" });
        const otherEmployee = await createUser({ email: "otheremployee@example.com", managerId: hr.id });
        const hrAgent = await loginAs(hr);

        const response = await hrAgent.post("/api/users/invite").send({
            firstName: "New",
            lastName: "Employee",
            email: "newemployee@example.com",
            role: "EMPLOYEE",
            managerId: otherEmployee.id,
        });

        expect(response.statusCode).toBe(400);
    });
});

// Re-inviting an address that already has a pending invitation. Before this,
// every case below hit the users-email unique index and came back as
// errorHandler's generic "a record with these details already exists" — with no
// resend endpoint and the pending account only cleaned up after the 12h TTL,
// HR had no way forward for the rest of the day.
describe("Re-inviting a pending employee (FR-001)", () => {
    const EMAIL = "pending-reinvite@example.com";

    async function invite(agent, overrides = {}) {
        return agent.post("/api/users/invite").send({
            firstName: "New",
            lastName: "Hire",
            email: EMAIL,
            role: "EMPLOYEE",
            ...overrides,
        });
    }

    it("issues a working new link, kills the old one, and reports itself as a resend", async () => {
        const hr = await createRootHr({ email: "reinvite-hr@example.com" });
        const hrAgent = await loginAs(hr);

        const first = await invite(hrAgent, { managerId: hr.id });
        expect(first.statusCode).toBe(201);
        expect(first.body.data.reissued).toBe(false);
        const firstToken = extractToken(first.body.data.inviteLink);

        const second = await invite(hrAgent, { managerId: hr.id });

        // 200, not 201: nothing was created this time.
        expect(second.statusCode).toBe(200);
        expect(second.body.data.reissued).toBe(true);
        const secondToken = extractToken(second.body.data.inviteLink);
        expect(secondToken).not.toBe(firstToken);

        // The whole point of a resend is one live credential, not two.
        const oldLink = await request(app).post("/api/auth/invitations/verify").send({ token: firstToken });
        expect(oldLink.statusCode).toBe(401);

        const newLink = await request(app).post("/api/auth/invitations/verify").send({ token: secondToken });
        expect(newLink.statusCode).toBe(200);

        // Superseded in place rather than stacked up, which is what keeps
        // PUBLIC_USER_COLUMNS' invited_by subquery single-valued.
        const rows = await pool.query(
            "SELECT COUNT(*)::int AS count FROM invitations i JOIN users u ON u.id = i.user_id WHERE lower(u.email) = lower($1)",
            [EMAIL]
        );
        expect(rows.rows[0].count).toBe(1);

        // And the new link still onboards them for real.
        const accepted = await request(app)
            .post("/api/auth/invitations/accept")
            .send({ token: secondToken, password: "NewPassword123!" });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.body.data.user.status).toBe("ACTIVE");
    });

    it("reissues against the stored row, ignoring a changed name, role and manager", async () => {
        const hr = await createRootHr({ email: "reinvite-ignore-hr@example.com" });
        const otherManager = await createUser({
            role: "MANAGER",
            managerId: hr.id,
            email: "reinvite-other-mgr@example.com",
        });
        const hrAgent = await loginAs(hr);

        const first = await invite(hrAgent, { managerId: hr.id });
        expect(first.statusCode).toBe(201);

        const second = await invite(hrAgent, {
            firstName: "Renamed",
            lastName: "Different",
            role: "MANAGER",
            managerId: otherManager.id,
        });

        expect(second.statusCode).toBe(200);
        expect(second.body.data.user.first_name).toBe("New");
        expect(second.body.data.user.last_name).toBe("Hire");
        expect(second.body.data.user.role).toBe("EMPLOYEE");
        expect(second.body.data.user.manager_id).toBe(hr.id);
    });

    it("lets an HR admin resend for someone in their scope they didn't create, without becoming the creator", async () => {
        // The inherited-account case the "creator or in-my-HR-scope" rule
        // exists for: the senior HR admin files the invite, but the invitee
        // reports to a second HR admin, so it's that second admin who ends up
        // chasing the onboarding. Note the direction matters — a scope check is
        // a downward subtree walk, so the invitee has to be *under* whoever
        // resends. An HR admin above them in the chain is not in scope, which
        // is what the other-branch case below also relies on.
        const creator = await createRootHr({ email: "reinvite-creator@example.com" });
        const scopedHr = await createUser({
            role: "HR_ADMIN",
            managerId: creator.id,
            email: "reinvite-scoped-hr@example.com",
        });

        const first = await invite(await loginAs(creator), { managerId: scopedHr.id });
        expect(first.statusCode).toBe(201);

        const second = await invite(await loginAs(scopedHr), { managerId: scopedHr.id });

        expect(second.statusCode).toBe(200);
        // Resending is not hiring: invited_by is the creator attribution that
        // changeManager/changeStatus read, so it must survive a colleague's
        // resend untouched.
        expect(second.body.data.user.invited_by).toBe(creator.id);
    });

    it("still refuses an address that belongs to an active account, with its own message", async () => {
        const hr = await createRootHr({ email: "reinvite-active-hr@example.com" });
        await createUser({ managerId: hr.id, email: EMAIL });

        const response = await invite(await loginAs(hr), { managerId: hr.id });

        expect(response.statusCode).toBe(409);
        // Distinguished from the pending case on purpose: HR's next step is to
        // find them in the employee list, not to resend anything.
        expect(response.body.message).toBe("An account with this email already exists");
    });

    it("refuses a resend from an HR admin in another branch, leaving the original link alive", async () => {
        const owningHr = await createRootHr({ email: "reinvite-owner@example.com" });
        const strangerHr = await createRootHr({ email: "reinvite-stranger@example.com" });

        const first = await invite(await loginAs(owningHr), { managerId: owningHr.id });
        expect(first.statusCode).toBe(201);
        const firstToken = extractToken(first.body.data.inviteLink);

        const second = await invite(await loginAs(strangerHr), { managerId: strangerHr.id });

        expect(second.statusCode).toBe(409);
        expect(second.body.message).toBe("This email already has a pending invitation");

        // A refused resend must not have burned the real one.
        const oldLink = await request(app).post("/api/auth/invitations/verify").send({ token: firstToken });
        expect(oldLink.statusCode).toBe(200);
    });

    it("reissues for an invitation that has already lapsed but not yet been cleaned up", async () => {
        // The window this closes: expires_at is in the past, so the link is
        // dead, but deleteExpiredInvitees (which runs lazily off the user list)
        // hasn't removed the account yet, so the email is still taken.
        const hr = await createRootHr({ email: "reinvite-lapsed-hr@example.com" });
        const hrAgent = await loginAs(hr);

        const first = await invite(hrAgent, { managerId: hr.id });
        expect(first.statusCode).toBe(201);
        const firstToken = extractToken(first.body.data.inviteLink);

        await pool.query(
            `UPDATE invitations SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
             WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
            [EMAIL]
        );

        const expired = await request(app).post("/api/auth/invitations/verify").send({ token: firstToken });
        expect(expired.statusCode).toBe(401);

        const second = await invite(hrAgent, { managerId: hr.id });

        expect(second.statusCode).toBe(200);
        expect(second.body.data.reissued).toBe(true);
        const revived = await request(app)
            .post("/api/auth/invitations/verify")
            .send({ token: extractToken(second.body.data.inviteLink) });
        expect(revived.statusCode).toBe(200);
    });
});
