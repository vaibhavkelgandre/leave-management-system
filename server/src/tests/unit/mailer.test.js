// Unit tests for the mail transport — the one module that knows a provider
// exists. Pure env-var + payload-shape logic with `fetch` stubbed, so it's
// tested here rather than through an HTTP round trip.
//
// Worth testing directly for two reasons. First, the unconfigured path doesn't
// fail loudly: it logs the full message body, and for invites and password
// resets that body *contains a live single-use token* — so on a deployed
// environment a config bug is a credential leak into log aggregation rather
// than a missing email. Second, this file exists to absorb provider swaps (two
// so far), and a payload shape is exactly the kind of thing that is only wrong
// in production.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendMail, isMailConfigured } from "../../config/mailer.js";

// The suite's own .env/.env.test may set any of these, so each test starts
// from "nothing configured" and the originals go back afterwards — otherwise
// a case that deletes a var would leak that into every later test file.
const MAIL_ENV_KEYS = ["BREVO_API_KEY", "MAIL_FROM", "NODE_ENV"];

const originalEnv = {};
let originalFetch;

beforeEach(() => {
    for (const key of MAIL_ENV_KEYS) {
        originalEnv[key] = process.env[key];
        delete process.env[key];
    }
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    for (const key of MAIL_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    globalThis.fetch = originalFetch;
});

// Stubs a successful provider response and returns the mock so a test can
// read back the URL, headers and parsed body it was called with. 201 because
// that is what Brevo answers; sendMail checks `ok` rather than a specific
// code, so the exact number is not load-bearing.
function stubFetch({ ok = true, status = 201, body = "" } = {}) {
    const mock = vi.fn().mockResolvedValue({
        ok,
        status,
        text: async () => body,
    });
    globalThis.fetch = mock;
    return mock;
}

// Reads the JSON body a stubbed fetch was called with.
function sentBody(mock) {
    return JSON.parse(mock.mock.calls[0][1].body);
}

// Every send path below needs NODE_ENV to be something other than "test",
// because sendMail hard-returns under test to guarantee the suite can never
// deliver real email. Setting it per test keeps that guard itself testable.
function enableSending() {
    process.env.NODE_ENV = "production";
}

const FROM = "Leave Management System <sender@example.com>";
const MESSAGE = { to: "someone@example.com", subject: "Hello", text: "plain body", html: "<p>rich body</p>" };

describe("isMailConfigured", () => {
    it("is false when no api key is set", () => {
        process.env.MAIL_FROM = FROM;
        expect(isMailConfigured()).toBe(false);
    });

    // A key without a sender is the common half-filled deployment, and it has
    // to read as unconfigured: Brevo refuses an unverified sender, so the
    // alternative is a 4xx on every single send.
    it("is false when a key is set but MAIL_FROM is not", () => {
        process.env.BREVO_API_KEY = "brevo-key";
        expect(isMailConfigured()).toBe(false);
    });

    it("is true once both are present", () => {
        process.env.BREVO_API_KEY = "brevo-key";
        process.env.MAIL_FROM = FROM;
        expect(isMailConfigured()).toBe(true);
    });

    // Regression: a SendGrid key used to be honoured as a fallback. That
    // branch was removed once Brevo was verified, because a fallback pointing
    // at a provider whose free access expires is worse than none —
    // isMailConfigured() would read true while nothing could be delivered.
    it("ignores a leftover SENDGRID_API_KEY entirely", () => {
        process.env.SENDGRID_API_KEY = "sendgrid-key";
        process.env.MAIL_FROM = FROM;
        expect(isMailConfigured()).toBe(false);
        delete process.env.SENDGRID_API_KEY;
    });
});

describe("sendMail non-sending paths", () => {
    it("never sends under NODE_ENV=test, whatever is configured", async () => {
        process.env.NODE_ENV = "test";
        process.env.BREVO_API_KEY = "brevo-key";
        process.env.MAIL_FROM = FROM;
        const mock = stubFetch();

        await expect(sendMail(MESSAGE)).resolves.toBe(false);
        expect(mock).not.toHaveBeenCalled();
    });

    it("logs instead of sending when unconfigured, and reports false", async () => {
        enableSending();
        const mock = stubFetch();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await expect(sendMail(MESSAGE)).resolves.toBe(false);
        expect(mock).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});

describe("Brevo payload", () => {
    beforeEach(() => {
        enableSending();
        process.env.BREVO_API_KEY = "brevo-key";
        process.env.MAIL_FROM = FROM;
    });

    it("posts to Brevo's transactional endpoint", async () => {
        const mock = stubFetch();
        await expect(sendMail(MESSAGE)).resolves.toBe(true);
        expect(mock.mock.calls[0][0]).toBe("https://api.brevo.com/v3/smtp/email");
    });

    // Auth is an `api-key` header, not `Authorization: Bearer`. Sending a
    // Bearer token fails as a 401, which reads as a bad key rather than the
    // wrong scheme — so this is pinned.
    it("authenticates with an api-key header, not a bearer token", async () => {
        const mock = stubFetch();
        await sendMail(MESSAGE);

        const { headers } = mock.mock.calls[0][1];
        expect(headers["api-key"]).toBe("brevo-key");
        expect(headers.Authorization).toBeUndefined();
    });

    it("maps the neutral message onto Brevo's field names", async () => {
        const mock = stubFetch();
        await sendMail(MESSAGE);

        expect(sentBody(mock)).toMatchObject({
            sender: { email: "sender@example.com", name: "Leave Management System" },
            to: [{ email: "someone@example.com" }],
            subject: "Hello",
            textContent: "plain body",
            htmlContent: "<p>rich body</p>",
        });
    });

    // A message with no text part is scored as spam and renders blank in
    // text-only clients, so textContent is always present even when the
    // caller sends no HTML.
    it("still sends a text part when there is no html", async () => {
        const mock = stubFetch();
        await sendMail({ ...MESSAGE, html: undefined });

        const body = sentBody(mock);
        expect(body.textContent).toBe("plain body");
        expect(body).not.toHaveProperty("htmlContent");
    });

    // The payslip PDF is the only caller that attaches anything. Brevo names
    // the key `attachment` (singular) and wants base64 with no content type.
    it("base64-encodes an attachment under Brevo's singular key", async () => {
        const mock = stubFetch();
        await sendMail({
            ...MESSAGE,
            attachments: [{ filename: "payslip.pdf", content: Buffer.from("pdf-bytes"), contentType: "application/pdf" }],
        });

        expect(sentBody(mock).attachment).toEqual([
            { name: "payslip.pdf", content: Buffer.from("pdf-bytes").toString("base64") },
        ]);
    });

    it("omits the attachment key entirely when there are none", async () => {
        const mock = stubFetch();
        await sendMail(MESSAGE);
        expect(sentBody(mock)).not.toHaveProperty("attachment");
    });

    // Regression: a hosting dashboard stores quotes literally where dotenv
    // strips them, so this exact value has reached production before. The old
    // nodemailer parser turned it into the garbage address
    // `"Name <addr"@example.com` and sent it anyway.
    it("absorbs a fully quoted MAIL_FROM rather than sending a broken sender", async () => {
        process.env.MAIL_FROM = `"${FROM}"`;
        const mock = stubFetch();
        await sendMail(MESSAGE);

        expect(sentBody(mock).sender).toEqual({
            email: "sender@example.com",
            name: "Leave Management System",
        });
    });

    it("accepts a bare address with no display name", async () => {
        process.env.MAIL_FROM = "sender@example.com";
        const mock = stubFetch();
        await sendMail(MESSAGE);

        expect(sentBody(mock).sender).toEqual({ email: "sender@example.com" });
    });

    // A trailing newline on a pasted key produces a 401 indistinguishable
    // from a wrong key, which is a genuinely slow thing to diagnose.
    it("trims whitespace off a pasted key", async () => {
        process.env.BREVO_API_KEY = "  brevo-key\n";
        const mock = stubFetch();
        await sendMail(MESSAGE);

        expect(mock.mock.calls[0][1].headers["api-key"]).toBe("brevo-key");
    });
});

describe("sendMail failures", () => {
    beforeEach(() => {
        enableSending();
        process.env.BREVO_API_KEY = "brevo-key";
        process.env.MAIL_FROM = FROM;
    });

    // The provider's own error text is the only way to tell a bad key from an
    // unverified sender. `Key not found` in particular is what Brevo answers
    // for an `xsmtpsib-` SMTP credential used against the HTTP API — the
    // wrong *kind* of key, not a wrong one — so the body has to reach the log.
    it("surfaces the status and provider body when a send is rejected", async () => {
        stubFetch({ ok: false, status: 401, body: '{"message":"Key not found"}' });

        await expect(sendMail(MESSAGE)).rejects.toThrow(/401.*Key not found/s);
    });

    it("reports a network-level failure as one thrown error", async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("socket hang up"));

        await expect(sendMail(MESSAGE)).rejects.toThrow(/unreachable.*socket hang up/s);
    });
});
