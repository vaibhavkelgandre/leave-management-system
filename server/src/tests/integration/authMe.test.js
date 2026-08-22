import request from "supertest";
import jwt from "jsonwebtoken";
import { describe, it, expect } from "vitest";
import app from "../../app.js";
import pool from "../../config/db.js";
import { createUser, createRootHr } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { AUTH_COOKIE_NAME } from "../../utils/cookies.js";

describe("GET /api/auth/me", () => {
    it("returns 401 without a cookie", async () => {
        const response = await request(app).get("/api/auth/me");
        expect(response.statusCode).toBe(401);
    });

    it("returns the current user for a valid session", async () => {
        const user = await createUser({ email: "me@example.com", role: "MANAGER" });
        const agent = await loginAs(user);

        const response = await agent.get("/api/auth/me");

        expect(response.statusCode).toBe(200);
        expect(response.body.data.user.email).toBe(user.email);
        expect(response.body.data.user.role).toBe("MANAGER");
    });

    it("includes the caller's direct manager and nearest HR ancestor", async () => {
        const hr = await createRootHr({ email: "reporting-hr@example.com", firstName: "Priya", lastName: "HR" });
        const manager = await createUser({
            email: "reporting-manager@example.com",
            role: "MANAGER",
            managerId: hr.id,
            firstName: "Manoj",
            lastName: "Manager",
        });
        const employee = await createUser({ email: "reporting-employee@example.com", managerId: manager.id });
        const agent = await loginAs(employee);

        const response = await agent.get("/api/auth/me");

        expect(response.body.data.user.manager).toMatchObject({ id: manager.id, first_name: "Manoj" });
        expect(response.body.data.user.hr).toMatchObject({ id: hr.id, first_name: "Priya" });
    });

    it("resolves the nearest HR_ADMIN ancestor even when it isn't the direct manager", async () => {
        const rootHr = await createRootHr({ email: "root-hr@example.com" });
        const middleManager = await createUser({
            email: "middle-manager@example.com",
            role: "MANAGER",
            managerId: rootHr.id,
        });
        const employee = await createUser({ email: "deep-employee@example.com", managerId: middleManager.id });
        const agent = await loginAs(employee);

        const response = await agent.get("/api/auth/me");

        expect(response.body.data.user.manager.id).toBe(middleManager.id);
        expect(response.body.data.user.hr.id).toBe(rootHr.id);
    });

    it("returns null manager and hr for a root HR admin with nobody above them", async () => {
        const rootHr = await createRootHr({ email: "lonely-root-hr@example.com" });
        const agent = await loginAs(rootHr);

        const response = await agent.get("/api/auth/me");

        expect(response.body.data.user.manager).toBeNull();
        expect(response.body.data.user.hr).toBeNull();
    });

    it("invalidates the session once the user is deactivated", async () => {
        const user = await createUser({ email: "deactivated@example.com" });
        const agent = await loginAs(user);

        await pool.query("UPDATE users SET status = 'INACTIVE' WHERE id = $1", [user.id]);

        const response = await agent.get("/api/auth/me");
        expect(response.statusCode).toBe(401);
    });
});

// requireAuth verifies the cookie's signature and expiry before it ever looks
// the user up, and re-reads role/status from the database rather than trusting
// the payload. These cases exercise the tokens an attacker would actually
// present — none of them should reach a handler, and none should produce a 500
// (a stack trace is itself information).
describe("GET /api/auth/me — session token integrity", () => {
    const asCookie = (token) => request(app).get("/api/auth/me").set("Cookie", `${AUTH_COOKIE_NAME}=${token}`);

    it("rejects a token signed with the wrong secret", async () => {
        const user = await createUser({ email: "forged@example.com" });
        // Correct payload, correct algorithm, wrong key — the shape a forged
        // token takes when the attacker knows everything except the secret.
        const forged = jwt.sign({ sub: user.id, role: "EMPLOYEE" }, "not-the-real-secret", { expiresIn: "8h" });

        const response = await asCookie(forged);

        expect(response.statusCode).toBe(401);
        expect(response.body.success).toBe(false);
    });

    it("rejects a token whose algorithm was stripped to none", async () => {
        const user = await createUser({ email: "alg-none@example.com" });
        // The classic JWT downgrade: a valid header/payload with an empty
        // signature, which a verifier that trusts the header's own `alg`
        // accepts. jsonwebtoken must refuse it.
        const unsigned = jwt.sign({ sub: user.id, role: "EMPLOYEE" }, "", { algorithm: "none" });

        const response = await asCookie(unsigned);

        expect(response.statusCode).toBe(401);
    });

    it("rejects an expired but otherwise perfectly valid token", async () => {
        const user = await createUser({ email: "expired@example.com" });
        const expired = jwt.sign({ sub: user.id, role: "EMPLOYEE" }, process.env.JWT_SECRET, { expiresIn: "-1s" });

        const response = await asCookie(expired);

        expect(response.statusCode).toBe(401);
        expect(response.body.message).toBe("Session expired");
    });

    it("rejects a malformed cookie value that isn't a JWT at all", async () => {
        const response = await asCookie("not.a.jwt");

        expect(response.statusCode).toBe(401);
        expect(response.body.success).toBe(false);
    });

    it("clears the cookie when it rejects a bad token, so the browser stops resending it", async () => {
        const response = await asCookie("not.a.jwt");

        const cleared = (response.headers["set-cookie"] || []).find((cookie) =>
            cookie.startsWith(`${AUTH_COOKIE_NAME}=`)
        );
        expect(cleared).toBeDefined();
        // clearCookie emits an empty value with an already-past expiry.
        expect(cleared).toMatch(new RegExp(`^${AUTH_COOKIE_NAME}=;`));
    });

    it("rejects a correctly signed token for a user id that doesn't exist", async () => {
        // Not forgeable in practice, but it's the path a deleted account (or a
        // token minted against a different database) takes, and it must be a
        // 401 rather than a crash on a null user row.
        const orphaned = jwt.sign(
            { sub: "00000000-0000-0000-0000-000000000000", role: "SUPER_ADMIN" },
            process.env.JWT_SECRET,
            { expiresIn: "8h" }
        );

        const response = await asCookie(orphaned);

        expect(response.statusCode).toBe(401);
    });

    it("rejects a correctly signed token whose subject isn't a user id at all", async () => {
        // A non-UUID subject reaches Postgres as an invalid uuid literal, so
        // without a guard in requireAuth this answers 500 (and logs a stack)
        // instead of 401.
        const nonsense = jwt.sign({ sub: "'; DROP TABLE users; --", role: "SUPER_ADMIN" }, process.env.JWT_SECRET, {
            expiresIn: "8h",
        });

        const response = await asCookie(nonsense);

        expect(response.statusCode).toBe(401);
    });

    it("ignores the role claimed in the token and uses the database's own role", async () => {
        // The payload carries a role, but requireAuth re-reads it — a token
        // whose claim was swapped for SUPER_ADMIN must still act as an
        // employee. (Only reachable with the real secret; asserted because
        // "re-fetch, don't trust the payload" is the property being relied on.)
        const user = await createUser({ email: "role-claim@example.com", role: "EMPLOYEE" });
        const escalated = jwt.sign({ sub: user.id, role: "SUPER_ADMIN" }, process.env.JWT_SECRET, {
            expiresIn: "8h",
        });

        const response = await asCookie(escalated);

        expect(response.statusCode).toBe(200);
        expect(response.body.data.user.role).toBe("EMPLOYEE");
    });
});
