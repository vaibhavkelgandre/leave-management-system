import request from "supertest";
import { describe, it, expect } from "vitest";
import app from "../../app.js";
import pool from "../../config/db.js";

const REG_CODE = process.env.HR_REGISTRATION_CODE;

describe("POST /api/auth/register/hr", () => {
    it("creates the single SUPER_ADMIN as the tree root, already VERIFIED", async () => {
        const response = await request(app).post("/api/auth/register/hr").send({
            registrationCode: REG_CODE,
            firstName: "Root",
            lastName: "Admin",
            email: "root@example.com",
            password: "Password123!",
        });

        expect(response.statusCode).toBe(201);
        expect(response.body.success).toBe(true);
        expect(response.body.data.user.role).toBe("SUPER_ADMIN");
        expect(response.body.data.user.manager_id).toBeNull();
        expect(response.body.data.user.profile_status).toBe("VERIFIED");
        expect(response.headers["set-cookie"]).toBeDefined();
        expect(JSON.stringify(response.body)).not.toContain("password_hash");
    });

    it("rejects an invalid registration code", async () => {
        const response = await request(app).post("/api/auth/register/hr").send({
            registrationCode: "wrong-code",
            firstName: "Root",
            lastName: "Admin",
            email: "root2@example.com",
            password: "Password123!",
        });

        expect(response.statusCode).toBe(401);
        expect(response.body.success).toBe(false);
    });

    it("rejects a second bootstrap attempt once a super admin already exists", async () => {
        const first = await request(app).post("/api/auth/register/hr").send({
            registrationCode: REG_CODE,
            firstName: "Root",
            lastName: "Admin",
            email: "root3@example.com",
            password: "Password123!",
        });
        expect(first.statusCode).toBe(201);

        const second = await request(app).post("/api/auth/register/hr").send({
            registrationCode: REG_CODE,
            firstName: "Second",
            lastName: "Admin",
            email: "second@example.com",
            password: "Password123!",
        });

        expect(second.statusCode).toBe(409);
        expect(second.body.success).toBe(false);

        // The first super admin is untouched by the rejected second attempt.
        const stillOnlyOne = await request(app).post("/api/auth/register/hr").send({
            registrationCode: REG_CODE,
            firstName: "Third",
            lastName: "Admin",
            email: "third@example.com",
            password: "Password123!",
        });
        expect(stillOnlyOne.statusCode).toBe(409);
    });

    // The sequential test above is satisfied by registerHrRoot's
    // existsUserWithRole check alone. This one isn't: both requests pass that
    // check (it runs before the bcrypt hash, so neither has inserted yet by
    // the time the other looks) and only uq_users_single_super_admin
    // (migration 038) can separate them. Without that index both inserts
    // commit and the singleton is silently two accounts.
    it("rejects the loser of two simultaneous bootstraps instead of creating two super admins", async () => {
        const bootstrap = (email) =>
            request(app).post("/api/auth/register/hr").send({
                registrationCode: REG_CODE,
                firstName: "Root",
                lastName: "Admin",
                email,
                password: "Password123!",
            });

        const [first, second] = await Promise.all([
            bootstrap("race-one@example.com"),
            bootstrap("race-two@example.com"),
        ]);

        // Which request wins is genuinely undecided, so assert on the pair.
        expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);

        // The loser gets the same message as a sequential second attempt, not
        // the generic "a record with these details already exists" that an
        // unmapped unique violation would produce.
        const loser = first.statusCode === 409 ? first : second;
        expect(loser.body.success).toBe(false);
        expect(loser.body.message).toBe("A super admin account already exists");

        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE r.role_name = 'SUPER_ADMIN'`
        );
        expect(rows[0].count).toBe(1);
    });
});
