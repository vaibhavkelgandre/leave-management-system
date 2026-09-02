// Covers middlewares/rateLimiter.js: the IP-level limits on the pre-auth
// endpoints. Limiting is off under NODE_ENV=test by default (the rest of the
// suite makes hundreds of logins from one loopback address), so every test here
// switches it on explicitly and clears the counters afterwards — a limiter is
// stateful, so a leaked count would fail an unrelated test later.
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import app from "../../app.js";
import { resetRateLimiters } from "../../middlewares/rateLimiter.js";
import { createUser, DEFAULT_PASSWORD } from "./helpers/factories.js";

const REG_CODE = process.env.HR_REGISTRATION_CODE;

// Hits an endpoint `times` times and returns the last response, so a test can
// spend a limiter's whole budget in one line before asserting on the next call.
async function hit(times, send) {
    let response;
    for (let i = 0; i < times; i += 1) response = await send();
    return response;
}

describe("rate limiting on the pre-auth endpoints", () => {
    beforeEach(() => {
        process.env.RATE_LIMIT_ENABLED = "true";
        resetRateLimiters();
    });

    afterEach(() => {
        delete process.env.RATE_LIMIT_ENABLED;
        resetRateLimiters();
    });

    it("refuses further sign-in attempts with 429 once the limit is spent", async () => {
        const failedLogin = () =>
            request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "WrongPassword1!" });

        const lastAllowed = await hit(20, failedLogin);
        expect(lastAllowed.statusCode).toBe(401);

        const blocked = await failedLogin();
        expect(blocked.statusCode).toBe(429);
        // Same envelope as every other error, so the client needs no special case.
        expect(blocked.body.success).toBe(false);
        expect(blocked.body.message).toMatch(/too many sign-in attempts/i);
        expect(blocked.body.errors).toEqual([]);
    });

    it("does not count successful sign-ins against the limit", async () => {
        const user = await createUser({ email: "rate-limit-ok@example.com" });

        // Well past the 20-attempt ceiling: a shared office IP signing in all
        // day must never be throttled, which is what skipSuccessfulRequests buys.
        const lastAllowed = await hit(25, () =>
            request(app).post("/api/auth/login").send({ email: user.email, password: DEFAULT_PASSWORD })
        );
        expect(lastAllowed.statusCode).toBe(200);

        const stillAllowed = await request(app)
            .post("/api/auth/login")
            .send({ email: user.email, password: "WrongPassword1!" });
        expect(stillAllowed.statusCode).toBe(401);
    });

    it("shares the sign-in limit between the password and Google login routes", async () => {
        await hit(20, () =>
            request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "WrongPassword1!" })
        );

        const blocked = await request(app).post("/api/auth/google").send({ idToken: "not-a-real-token" });
        expect(blocked.statusCode).toBe(429);
    });

    it("limits guesses at the HR registration code", async () => {
        const attempt = () =>
            request(app).post("/api/auth/register/hr").send({
                firstName: "Guess",
                lastName: "Guess",
                email: `guess-${Math.random()}@example.com`,
                password: "Password1!",
                registrationCode: "wrong-code",
            });

        const lastAllowed = await hit(5, attempt);
        expect(lastAllowed.statusCode).not.toBe(429);

        const blocked = await attempt();
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body.message).toMatch(/too many registration attempts/i);
    });

    it("limits password reset requests by IP, counting successful ones too", async () => {
        // Successes count here (unlike login) because a success is what sends an
        // email — the abuse being capped is mail-quota burn across many addresses,
        // which issuePasswordReset's per-account cooldown cannot see.
        const attempt = () =>
            request(app).post("/api/auth/password-reset/request").send({ email: `nobody-${Math.random()}@example.com` });

        const lastAllowed = await hit(10, attempt);
        expect(lastAllowed.statusCode).toBe(200);

        const blocked = await attempt();
        expect(blocked.statusCode).toBe(429);
    });

    it("limits single-use-token lookups across the invitation and reset-confirm routes", async () => {
        const lastAllowed = await hit(30, () =>
            request(app).post("/api/auth/invitations/verify").send({ token: "a".repeat(64) })
        );
        expect(lastAllowed.statusCode).not.toBe(429);

        const blocked = await request(app)
            .post("/api/auth/password-reset/confirm")
            .send({ token: "a".repeat(64), password: "Password1!" });
        expect(blocked.statusCode).toBe(429);
    });

    it("leaves the rest of the API unlimited — only the pre-auth routes are gated", async () => {
        const user = await createUser({ email: "rate-limit-session@example.com" });
        const login = await request(app)
            .post("/api/auth/login")
            .send({ email: user.email, password: DEFAULT_PASSWORD });
        const cookie = login.headers["set-cookie"];

        // The client polls /notifications and the approvals badge every 30s, so a
        // limiter over the whole API would throttle ordinary use behind one office IP.
        const lastAllowed = await hit(40, () => request(app).get("/api/auth/me").set("Cookie", cookie));
        expect(lastAllowed.statusCode).toBe(200);
    });

    it("is inert while disabled, which is how the rest of the suite runs", async () => {
        process.env.RATE_LIMIT_ENABLED = "false";

        const lastAllowed = await hit(25, () =>
            request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "WrongPassword1!" })
        );
        expect(lastAllowed.statusCode).toBe(401);
    });
});
