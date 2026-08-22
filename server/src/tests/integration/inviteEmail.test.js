// The delivery half of the invite flow (the redeem/accept half lives in
// invitationFlow.test.js, and expiry sweeping in inviteExpiry.test.js): the
// link is emailed to the invitee, the window it stays valid for is short and
// clamped, and a mail failure never costs HR the account they just created.
//
// mailService is mocked rather than the SMTP transport, matching
// passwordReset.test.js and how cloudinaryService is mocked elsewhere — the
// point is to exercise the real DB and the real rules without credentials or
// network access, and to keep passing when the provider behind it is swapped.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pool from "../../config/db.js";
import { createRootHr } from "./helpers/factories.js";
import { loginAs } from "./helpers/authHelpers.js";
import { sendEmployeeInviteEmail } from "../../services/mailService.js";

vi.mock("../../services/mailService.js", () => ({
    sendEmployeeInviteEmail: vi.fn().mockResolvedValue(true),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
    sendSalarySlipEmail: vi.fn().mockResolvedValue(true),
}));

const originalTtl = process.env.INVITE_TOKEN_TTL_HOURS;

beforeEach(() => {
    vi.clearAllMocks();
    sendEmployeeInviteEmail.mockResolvedValue(true);
});

afterEach(() => {
    if (originalTtl === undefined) delete process.env.INVITE_TOKEN_TTL_HOURS;
    else process.env.INVITE_TOKEN_TTL_HOURS = originalTtl;
});

async function invite(agent, overrides = {}) {
    return agent.post("/api/users/invite").send({
        firstName: "New",
        lastName: "Hire",
        email: "invitee@example.com",
        role: "EMPLOYEE",
        ...overrides,
    });
}

async function expiryFor(email) {
    const result = await pool.query(
        `SELECT i.expires_at FROM invitations i JOIN users u ON u.id = i.user_id WHERE u.email = $1`,
        [email]
    );
    return result.rows[0]?.expires_at ?? null;
}

describe("Invite email delivery", () => {
    it("emails the invitee the same link it returns to HR, with the inviter's name and the expiry window", async () => {
        process.env.INVITE_TOKEN_TTL_HOURS = "12";
        const hr = await createRootHr({ email: "hr-invite-mail@example.com", firstName: "Priya", lastName: "Shah" });
        const hrAgent = await loginAs(hr);

        const response = await invite(hrAgent, { managerId: hr.id });

        expect(response.statusCode).toBe(201);
        expect(sendEmployeeInviteEmail).toHaveBeenCalledTimes(1);
        const [args] = sendEmployeeInviteEmail.mock.calls.at(-1);
        expect(args).toMatchObject({
            to: "invitee@example.com",
            firstName: "New",
            role: "EMPLOYEE",
            expiresInHours: 12,
            invitedByName: "Priya Shah",
        });
        // The emailed link and HR's fallback copy must be the same credential
        // — two tokens for one invite would mean whichever was used second
        // silently failed.
        expect(args.inviteLink).toBe(response.body.data.inviteLink);
        expect(response.body.data.emailSent).toBe(true);
    });

    it("stores an expiry matching the configured window", async () => {
        process.env.INVITE_TOKEN_TTL_HOURS = "12";
        const hr = await createRootHr({ email: "hr-invite-ttl@example.com" });
        const hrAgent = await loginAs(hr);

        await invite(hrAgent, { managerId: hr.id });

        const expiresAt = await expiryFor("invitee@example.com");
        const hoursFromNow = (new Date(expiresAt).getTime() - Date.now()) / (60 * 60 * 1000);
        // Wide tolerance on purpose: this asserts "hours, not days" — the
        // security property — not the clock arithmetic.
        expect(hoursFromNow).toBeGreaterThan(11);
        expect(hoursFromNow).toBeLessThan(13);
    });

    // The window is the whole point of emailing rather than hand-sharing the
    // link, so a stray value in the environment must not be able to widen it
    // indefinitely.
    it("clamps an absurd configured window down to the maximum", async () => {
        process.env.INVITE_TOKEN_TTL_HOURS = "2400";
        const hr = await createRootHr({ email: "hr-invite-clamp@example.com" });
        const hrAgent = await loginAs(hr);

        await invite(hrAgent, { managerId: hr.id });

        const [args] = sendEmployeeInviteEmail.mock.calls.at(-1);
        expect(args.expiresInHours).toBe(72);
        const hoursFromNow =
            (new Date(await expiryFor("invitee@example.com")).getTime() - Date.now()) / (60 * 60 * 1000);
        expect(hoursFromNow).toBeLessThan(73);
    });

    it("falls back to the default window when the setting is unparseable", async () => {
        process.env.INVITE_TOKEN_TTL_HOURS = "not-a-number";
        const hr = await createRootHr({ email: "hr-invite-bad-ttl@example.com" });
        const hrAgent = await loginAs(hr);

        await invite(hrAgent, { managerId: hr.id });

        const [args] = sendEmployeeInviteEmail.mock.calls.at(-1);
        expect(args.expiresInHours).toBe(12);
    });

    // The account, its leave balances and its invitation row are all written
    // before the send — throwing here would show HR an error next to an
    // employee who was in fact created, and the returned link still works.
    it("still creates the account when the email fails, reporting emailSent=false", async () => {
        sendEmployeeInviteEmail.mockRejectedValue(new Error("SMTP down"));
        const hr = await createRootHr({ email: "hr-invite-fail@example.com" });
        const hrAgent = await loginAs(hr);

        const response = await invite(hrAgent, { managerId: hr.id });

        expect(response.statusCode).toBe(201);
        expect(response.body.data.emailSent).toBe(false);
        expect(response.body.data.inviteLink).toContain("/invite/");
        expect(await expiryFor("invitee@example.com")).not.toBeNull();
    });

    // `false` (not a rejection) is what an unconfigured SMTP setup or a
    // switched-off MAIL_FEATURE_EMPLOYEE_INVITE returns — the UI leans on the
    // link fallback in exactly this case, so the flag has to survive the trip.
    it("reports emailSent=false when the send was skipped rather than failed", async () => {
        sendEmployeeInviteEmail.mockResolvedValue(false);
        const hr = await createRootHr({ email: "hr-invite-skip@example.com" });
        const hrAgent = await loginAs(hr);

        const response = await invite(hrAgent, { managerId: hr.id });

        expect(response.statusCode).toBe(201);
        expect(response.body.data.emailSent).toBe(false);
    });

    it("emails the invitee a fresh link when HR resends a pending invitation", async () => {
        // Lives here rather than in invitationFlow.test.js because only this
        // file mocks mailService — config/mailer.js hard-returns under
        // NODE_ENV=test, so emailSent is always false without the mock.
        const hr = await createRootHr({ email: "resend-mail-hr@example.com" });
        const hrAgent = await loginAs(hr);

        const first = await invite(hrAgent, { managerId: hr.id });
        expect(first.statusCode).toBe(201);
        expect(sendEmployeeInviteEmail).toHaveBeenCalledTimes(1);
        const firstLink = sendEmployeeInviteEmail.mock.calls[0][0].inviteLink;

        const second = await invite(hrAgent, { managerId: hr.id });

        expect(second.statusCode).toBe(200);
        expect(second.body.data.emailSent).toBe(true);
        expect(sendEmployeeInviteEmail).toHaveBeenCalledTimes(2);

        const resent = sendEmployeeInviteEmail.mock.calls[1][0];
        expect(resent.to).toBe("invitee@example.com");
        expect(resent.inviteLink).not.toBe(firstLink);
        // Same template as a first invite, deliberately: the recipient may
        // never have seen the original, so "you've been invited" is still the
        // accurate thing to say, and a second template would need its own
        // feature flag for no gain.
        expect(resent.firstName).toBe("New");
        expect(resent.expiresInHours).toBeGreaterThan(0);
    });
});
