// GET /api/auth/bootstrap-status — what the signed-out login page reads to
// decide whether to offer the one-time setup route.
//
// It exists because there was previously no way to answer "can anyone sign in
// here yet?" without POSTing to the registration endpoint and reading the 409,
// which meant a fresh deployment's first visitor faced a login form no
// credential could satisfy and no explanation.
//
// Deliberately public and unauthenticated: the caller has no session and there
// is nobody to authenticate as. It exposes one bit, and only ever answers
// `true` for a database with no accounts in it.
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../app.js";
import pool from "../../config/db.js";
import { createSuperAdmin, createRootHr } from "./helpers/factories.js";

async function bootstrapStatus() {
    const response = await request(app).get("/api/auth/bootstrap-status");
    expect(response.statusCode).toBe(200);
    return response.body.data;
}

describe("GET /api/auth/bootstrap-status", () => {
    it("reports that bootstrap is needed on an empty database", async () => {
        // setup.js truncates every table before each test, so this is exactly
        // the state a freshly migrated deployment is in.
        expect(await bootstrapStatus()).toEqual({ needsBootstrap: true });
    });

    it("reports that bootstrap is done once a super admin exists", async () => {
        await createSuperAdmin({ email: "bootstrap-super@example.com" });

        expect(await bootstrapStatus()).toEqual({ needsBootstrap: false });
    });

    it("still reports bootstrap needed when other roles exist but no super admin", async () => {
        // The question is specifically "is there a SUPER_ADMIN", not "are there
        // any users". A database seeded with HR admins but no root still can't
        // approve a root HR admin's own leave, which is why the role exists.
        await createRootHr({ email: "bootstrap-hr@example.com" });

        expect(await bootstrapStatus()).toEqual({ needsBootstrap: true });
    });

    it("needs no authentication, because the caller cannot have a session yet", async () => {
        const response = await request(app).get("/api/auth/bootstrap-status");

        // Every other /api route answers 401 without a cookie. This one must
        // not, or the login page can never ask the question.
        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);
    });

    it("answers false immediately after a bootstrap registration", async () => {
        process.env.HR_REGISTRATION_CODE = "bootstrap-status-code";

        await request(app)
            .post("/api/auth/register/hr")
            .send({
                registrationCode: "bootstrap-status-code",
                firstName: "Root",
                lastName: "Admin",
                email: "bootstrap-registered@example.com",
                password: "password123",
            })
            .expect(201);

        // The client guard for /register reads this, so a stale `true` here is
        // what would leave the setup form reachable after setup.
        expect(await bootstrapStatus()).toEqual({ needsBootstrap: false });

        const count = await pool.query(
            `SELECT count(*)::int AS count FROM users u
             JOIN roles r ON r.id = u.role_id WHERE r.role_name = 'SUPER_ADMIN'`
        );
        expect(count.rows[0].count).toBe(1);
    });

    it("leaks nothing beyond the single flag", async () => {
        await createSuperAdmin({ email: "bootstrap-noleak@example.com" });

        const response = await request(app).get("/api/auth/bootstrap-status");

        // An unauthenticated endpoint must not become a way to learn who the
        // administrator is, how many accounts exist, or anything else.
        expect(Object.keys(response.body.data)).toEqual(["needsBootstrap"]);
        expect(JSON.stringify(response.body)).not.toContain("bootstrap-noleak@example.com");
    });
});
